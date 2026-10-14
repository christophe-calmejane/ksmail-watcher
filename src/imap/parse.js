//
//  parse.js
//  ksmail-watcher
//
//  The IMAP response subset the watcher needs, and not one line more: the tokenizer, the untagged responses of SELECT, and the FETCH items that make a notification (UID, FLAGS, INTERNALDATE, ENVELOPE, and the body PREFIX when a preview was asked for).
//
//  Bodies are not INTERPRETED here: what comes back for BODY[TEXT] is handed on as raw bytes, and the one place that reads them is snippet.js, which only runs when notifications.preview says so (see docs/PROTOCOL.md).
//

import { decodeHeaderText } from "./rfc2047.js";

const ATOM_SPECIALS = new Set([" ", "(", ")", "{", '"']);

/// Walks a logical line (segments + literals) and yields values:
///   { kind: "atom" | "quoted" | "literal" | "list" | "nil", value }
class Tokenizer {
  constructor(line) {
    this.segments = line.segments;
    this.segmentIndex = 0;
    this.text = this.segments[0]?.text ?? "";
    this.position = 0;
  }

  atEndOfSegment() {
    return this.position >= this.text.length;
  }

  /// Moves to the next segment, handing back the literal that closed the current one (that is where a literal value appears).
  advanceSegment() {
    const literal = this.segments[this.segmentIndex]?.literal ?? null;
    this.segmentIndex += 1;
    this.text = this.segments[this.segmentIndex]?.text ?? "";
    this.position = 0;
    return literal;
  }

  skipSpaces() {
    while (!this.atEndOfSegment() && this.text[this.position] === " ") {
      this.position += 1;
    }
  }

  next() {
    for (;;) {
      this.skipSpaces();
      if (this.atEndOfSegment()) {
        if (this.segmentIndex >= this.segments.length - 1) {
          return null;
        }
        const literal = this.advanceSegment();
        if (literal !== null) {
          return { kind: "literal", value: literal };
        }
        continue;
      }

      const character = this.text[this.position];
      if (character === ")") {
        this.position += 1;
        return { kind: "closeList" };
      }
      if (character === "(") {
        this.position += 1;
        return { kind: "list", value: this.readList() };
      }
      if (character === '"') {
        return { kind: "quoted", value: this.readQuoted() };
      }
      return this.readAtom();
    }
  }

  readList() {
    const items = [];
    for (;;) {
      const value = this.next();
      if (value === null || value.kind === "closeList") {
        return items;
      }
      items.push(value);
    }
  }

  readQuoted() {
    this.position += 1; // opening quote
    let result = "";
    while (!this.atEndOfSegment()) {
      const character = this.text[this.position];
      if (character === "\\" && this.position + 1 < this.text.length) {
        result += this.text[this.position + 1];
        this.position += 2;
        continue;
      }
      this.position += 1;
      if (character === '"') {
        break;
      }
      result += character;
    }
    return result;
  }

  readAtom() {
    let result = "";
    let bracketDepth = 0;
    while (!this.atEndOfSegment()) {
      const character = this.text[this.position];
      if (character === "[") {
        bracketDepth += 1;
      } else if (character === "]") {
        bracketDepth -= 1;
      } else if (bracketDepth === 0 && ATOM_SPECIALS.has(character)) {
        break;
      }
      result += character;
      this.position += 1;
    }
    if (result.toUpperCase() === "NIL") {
      return { kind: "nil", value: null };
    }
    return { kind: "atom", value: result };
  }
}

export function tokenize(line) {
  const tokenizer = new Tokenizer(line);
  const values = [];
  for (;;) {
    const value = tokenizer.next();
    if (value === null) {
      return values;
    }
    if (value.kind !== "closeList") {
      values.push(value);
    }
  }
}

/// Text content of a value, whatever carried it. Literals are decoded as UTF-8 with a Latin-1 fallback, like the Swift tokenizer.
export function stringValue(value) {
  if (!value) {
    return null;
  }
  switch (value.kind) {
    case "atom":
    case "quoted":
      return value.value;
    case "literal": {
      const text = value.value.toString("utf8");
      return text.includes("�") ? value.value.toString("latin1") : text;
    }
    default:
      return null;
  }
}

/// Response code of a status line: "* OK [UIDNEXT 4567] Predicted" gives { name: "UIDNEXT", arguments: "4567" }.
export function responseCode(text) {
  const match = /\[([A-Za-z0-9-]+)(?: ([^\]]*))?\]/.exec(text);
  if (!match) {
    return null;
  }
  return { name: match[1].toUpperCase(), arguments: match[2] ?? "" };
}

/// What SELECT tells us about a mailbox, gathered from its untagged lines plus the tagged completion.
export function selectSummary(untagged, completionText) {
  const summary = { exists: 0, uidValidity: null, uidNext: null, permanentFlags: [], readOnly: false };
  for (const line of untagged) {
    const text = line.segments.map((segment) => segment.text).join("");
    const exists = /^\* (\d+) EXISTS/i.exec(text);
    if (exists) {
      summary.exists = Number(exists[1]);
      continue;
    }
    const code = responseCode(text);
    if (!code) {
      continue;
    }
    if (code.name === "UIDVALIDITY") {
      summary.uidValidity = Number(code.arguments);
    } else if (code.name === "UIDNEXT") {
      summary.uidNext = Number(code.arguments);
    } else if (code.name === "PERMANENTFLAGS") {
      summary.permanentFlags = code.arguments.replace(/[()]/g, "").split(" ").filter(Boolean);
    }
  }
  const completionCode = responseCode(completionText ?? "");
  summary.readOnly = completionCode?.name === "READ-ONLY";
  return summary;
}

/// One address of an ENVELOPE list: (name adl mailbox host).
function parseAddress(value) {
  if (value.kind !== "list") {
    return null;
  }
  const parts = value.value;
  const name = stringValue(parts[0]);
  const mailbox = stringValue(parts[2]);
  const host = stringValue(parts[3]);
  if (!mailbox) {
    return null;
  }
  return {
    name: name ? decodeHeaderText(name) : null,
    address: host ? `${mailbox}@${host}` : mailbox,
  };
}

function parseAddressList(value) {
  if (!value || value.kind !== "list") {
    return [];
  }
  return value.value.map(parseAddress).filter(Boolean);
}

/// ENVELOPE, in the order RFC 3501 fixes:
///   date subject from sender reply-to to cc bcc in-reply-to message-id
export function parseEnvelope(value) {
  if (!value || value.kind !== "list") {
    return null;
  }
  const parts = value.value;
  const subject = stringValue(parts[1]);
  return {
    date: stringValue(parts[0]),
    subject: subject ? decodeHeaderText(subject) : null,
    from: parseAddressList(parts[2]),
    to: parseAddressList(parts[5]),
    messageId: stringValue(parts[9]),
  };
}

/// A FETCH line, as a map of its attributes:
///   * 12 FETCH (UID 4567 FLAGS (\Seen) ENVELOPE (...))
/// Returns null for any other untagged line.
export function parseFetch(line) {
  const values = tokenize(line);
  if (values.length < 3) {
    return null;
  }
  if (stringValue(values[0]) !== "*" || (stringValue(values[2]) ?? "").toUpperCase() !== "FETCH") {
    return null;
  }
  const sequence = Number(stringValue(values[1]));
  const items = values[3];
  if (!items || items.kind !== "list") {
    return null;
  }

  const result = {
    sequence,
    uid: null,
    flags: [],
    internalDate: null,
    envelope: null,
    bodyPrefix: null,
  };
  const list = items.value;
  for (let index = 0; index + 1 <= list.length; index += 1) {
    const name = (stringValue(list[index]) ?? "").toUpperCase();
    const argument = list[index + 1];
    switch (name) {
      case "UID":
        result.uid = Number(stringValue(argument));
        index += 1;
        break;
      case "FLAGS":
        result.flags = (argument?.kind === "list" ? argument.value : [])
          .map((flag) => stringValue(flag))
          .filter(Boolean);
        index += 1;
        break;
      case "INTERNALDATE":
        result.internalDate = stringValue(argument);
        index += 1;
        break;
      case "ENVELOPE":
        result.envelope = parseEnvelope(argument);
        index += 1;
        break;
      default:
        // BODY[TEXT], and BODY[TEXT]<0> when the server echoes the partial origin back, which most of them do. Raw bytes: the only thing that reads them is snippet.js.
        if (name.startsWith("BODY[")) {
          result.bodyPrefix = argument?.kind === "literal"
            ? argument.value
            : Buffer.from(stringValue(argument) ?? "", "latin1");
          index += 1;
        }
        break;
    }
  }
  return result;
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/// INTERNALDATE, "05-Sep-2026 12:34:56 +0200". Date.parse does not read that shape, and getting it wrong would silently drop every message as "too old to be news" at reconnection.
export function parseInternalDate(text) {
  if (!text) {
    return null;
  }
  const match = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})/.exec(text);
  if (!match) {
    return null;
  }
  const month = MONTHS[match[2].toLowerCase()];
  if (month === undefined) {
    return null;
  }
  const utc = Date.UTC(
    Number(match[3]), month, Number(match[1]),
    Number(match[4]), Number(match[5]), Number(match[6]),
  );
  const offsetMinutes = (Number(match[8]) * 60 + Number(match[9])) * (match[7] === "-" ? -1 : 1);
  return new Date(utc - offsetMinutes * 60_000);
}
