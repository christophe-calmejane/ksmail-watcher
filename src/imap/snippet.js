//
//  snippet.js
//  ksmail-watcher
//
//  One line of readable text out of the first bytes of a message body, so a notification can say what the message is about instead of stopping at its subject.
//
//  This file is the ONE place where the watcher looks at a body, and it only exists because it is asked for: `notifications.preview` decides, and the fetch itself is not issued at any other level (see docs/PROTOCOL.md). What it reads is a PREFIX of the body, taken with BODY.PEEK so nothing is marked read, and it is thrown away as soon as the preview is cut: nothing is written to the Pi's disk, and what leaves is the truncated preview, sealed for the device, never the bytes it came from. The prefix is read in one slice, and a second one glued to it for the message whose first slice stopped before what the reader will be shown (wantsLongerRead below).
//
//  It is deliberately the same shape as the app's own extraction (the ksMail app's SnippetExtractor.swift), so a message previewed on the lock screen and the same message in the list read alike. Where they differ, the app wins: it has the whole part and a real MIME parser, this has a slice.
//

/// How much of the body is asked of the server.
///
/// Bigger than the 2 KB the app reads per message in a page of fifty, and for a reason that is not generosity: this fetch happens ONCE, for a message that just arrived and is about to be announced. A newsletter opens with a stylesheet longer than 2 KB, so a small read comes back all <head> and the notification has nothing to say. The app spends the same 32 KB, but only on the messages whose first slice held no text (IMAPProvider.deepTextPrefixBytes).
///
/// 32 and not 16: a Cdiscount template measured here puts its <body> at 17 KB, behind a <head> of conditional comments, web fonts and inline CSS. It is a BUDGET and not a promise: past it, the message gets a SECOND read up to DEEP_PREFIX_BYTES (wantsLongerRead says which message), and past that the preview falls back to the message's text part, which for such a sender is "to see this message in html, click here" (docs/DESIGN.md, "Previews").
///
/// None of it is kept: what leaves for Apple is the truncated preview, never the bytes it came from.
export const PREFIX_BYTES = 32768;

/// How far the second read goes, in all: the slice above, then as much again, glued to it, for the one message whose first slice stopped before the rendition the reader will be shown.
///
/// The budget above was measured on where a template puts its <body>, but it is spent on the whole TEXT, and a multipart/alternative carries its text part FIRST: the Journal du Geek's (Mailchimp) is 22 KB of articles and tracking links, so the same 12 KB of <head> puts the <body> at 34 KB, and 32 KB came back as the text part's courtesy line and two URLs. That message needs 49 KB for its whole preview; the second read gives it 64. Only the messages that need it pay for it, one round trip each, and the watcher reads one message at a time (docs/PROTOCOL.md).
export const DEEP_PREFIX_BYTES = 2 * PREFIX_BYTES;

/// How much readable text is kept. SnippetExtractor.maxLength.
export const MAX_SNIPPET = 240;

/// Openers mail clients put on their own signature, folded to plain lower case ASCII before comparing. A human written signature has no marker at all, and guessing at one would cut real sentences.
const SIGNATURE_OPENERS = [
  "sent from my",
  "get outlook for",
  "download outlook for",
  "envoye de mon",
  "envoye depuis",
  "enviado desde mi",
  "inviato da",
  "von meinem",
  "gesendet mit",
];

/// The preview of a body prefix, or "" when nothing readable came out.
export function bodyPreview(buffer, { maxLength = MAX_SNIPPET } = {}) {
  if (!buffer || buffer.length === 0) {
    return "";
  }
  const text = stripSignature(readableText(buffer));
  return abridge(collapse(text), maxLength);
}

/// The text of the prefix, decoded, with markup taken out.
///
/// WHICH part is previewed is the whole subtlety, and the rule is written down in docs/DESIGN.md, "Previews": the rendition the READER will be shown, which is the html one whenever there is one and the slice can render it. A newsletter's text/plain part is regularly not the message at all, only a note about it ("if you cannot read this message ==> https://..."), and no test could recognize those: they come in every language and every shape.
function readableText(buffer) {
  const { plain, html, fallback } = textParts(buffer);
  if (html) {
    const rendered = plainTextFromHTML(decodePart(html)).trim();
    if (rendered) {
      return rendered;
    }
  }
  // The html part is there and the slice stopped inside its <head> (2.3). The text part is then all there is, whatever it says, and wantsLongerRead is what says a longer slice would do better.
  if (plain) {
    return decodePart(plain);
  }
  if (html) {
    return "";
  }
  const decoded = decodePart(fallback);
  return looksLikeHTML(decoded) ? plainTextFromHTML(decoded) : decoded;
}

/// Whether a longer slice would give a better preview: this one stopped before the rendition the reader will be shown.
///
/// The same question the app asks of its own slice before its second read (MIMEMessage.previewWantsLongerRead), and like there it is deliberately NOT "the preview came out empty": a newsletter whose text part carries "to see this message in html, click here" has a preview, and it is still the wrong one. Three shapes say yes:
///
///   * the html part is in the slice and renders to nothing, because the slice stopped inside its <head> (2.3);
///   * no html part yet, and the slice ended INSIDE the text part it previews. A multipart/alternative carries its text part first, and a long one (the Journal du Geek's is 22 KB) pushes the html part past the slice: the courtesy line would be announced over the article. A text part of that length with no html behind it costs one read for nothing, which is cheap and rare;
///   * not multipart at all, and the body is html that renders to nothing.
///
/// The caller still decides whether there IS anything further to read: a slice shorter than what was asked for is the whole body.
export function wantsLongerRead(buffer) {
  if (!buffer || buffer.length === 0) {
    return false;
  }
  const { plain, html, fallback, last } = textParts(buffer);
  if (html) {
    return plainTextFromHTML(decodePart(html)).trim().length === 0;
  }
  if (plain) {
    return last === plain && plain.cut;
  }
  const decoded = decodePart(fallback);
  return looksLikeHTML(decoded) && plainTextFromHTML(decoded).trim().length === 0;
}

/// The text/plain part and the text/html part the prefix holds, plus what to read when it holds neither (a message that is not multipart carries no part headers in its TEXT, so the encoding has to be guessed from the bytes), and the LAST leaf part the prefix reached, nested multiparts descended: with its `cut` flag, it says whether the prefix ended inside a part, which is what wantsLongerRead asks.
function textParts(buffer) {
  const empty = { plain: null, html: null, fallback: { headers: {}, body: buffer }, last: null };
  const boundary = firstBoundary(buffer);
  if (!boundary) {
    return empty;
  }
  const candidates = [];
  let last = null;
  for (const part of split(buffer, boundary)) {
    const type = contentType(part.headers);
    // multipart/alternative and friends: the text lives one level down, and a prefix rarely holds more than that first level anyway.
    if (type.startsWith("multipart/")) {
      const nested = textParts(part.body);
      candidates.push(...[nested.plain, nested.html].filter(Boolean));
      last = nested.last ?? part;
      continue;
    }
    last = part;
    if (type.startsWith("text/")) {
      candidates.push(part);
    }
  }
  const plain =
    candidates.find((part) => contentType(part.headers).startsWith("text/plain")) ?? null;
  const html =
    candidates.find((part) => contentType(part.headers).startsWith("text/html")) ?? null;
  return { plain, html, fallback: plain ?? html ?? candidates[0] ?? empty.fallback, last };
}

/// The outermost boundary, taken from the first boundary line. Read off the body rather than off a Content-Type header, because BODY[TEXT] does not carry the message's own headers.
function firstBoundary(buffer) {
  for (const line of buffer.toString("latin1").split(/\r?\n/, 200)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("--") || trimmed.length <= 2) {
      continue;
    }
    let boundary = trimmed.slice(2);
    if (boundary.endsWith("--")) {
      boundary = boundary.slice(0, -2);
    }
    if (boundary.length > 0 && !boundary.includes(" ")) {
      return boundary;
    }
  }
  return null;
}

/// The parts of a multipart body, each as its headers and its bytes. The LAST part of a truncated prefix has no closing boundary, and is kept, flagged `cut`: that is the common case here. Nothing after the closing boundary is a part.
function split(buffer, boundary) {
  const marker = `--${boundary}`;
  const text = buffer.toString("latin1");
  const parts = [];
  let index = text.indexOf(marker);
  while (index >= 0) {
    const start = text.indexOf("\n", index);
    if (start < 0) {
      break;
    }
    const next = text.indexOf(marker, start);
    const raw = text.slice(start + 1, next < 0 ? text.length : next);
    parts.push({ ...parseHeaders(Buffer.from(raw, "latin1")), cut: next < 0 });
    if (next < 0 || text.startsWith("--", next + marker.length)) {
      break;
    }
    index = next;
  }
  return parts;
}

/// Splits a part into its headers and its body at the blank line. A part whose headers are cut short by the prefix has no blank line and is treated as headers only, which is what it is.
function parseHeaders(buffer) {
  const text = buffer.toString("latin1");
  const blankLine = /\r?\n\r?\n/.exec(text);
  if (!blankLine) {
    return { headers: headerMap(text), body: Buffer.alloc(0) };
  }
  return {
    headers: headerMap(text.slice(0, blankLine.index)),
    body: Buffer.from(text.slice(blankLine.index + blankLine[0].length), "latin1"),
  };
}

function headerMap(text) {
  const headers = {};
  // Unfold first: a Content-Type with its charset on the next line is ordinary, and reading it folded loses the charset.
  const unfolded = text.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

function contentType(headers) {
  return (headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
}

function parameter(value, name) {
  const match = new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, "i").exec(value ?? "");
  return match ? match[1].trim() : null;
}

/// Undoes the transfer encoding, then the charset.
function decodePart(part) {
  const encoding = (part.headers["content-transfer-encoding"] ?? "")
    .trim()
    .toLowerCase();
  const charset = parameter(part.headers["content-type"], "charset");
  let bytes = part.body;
  if (encoding === "base64") {
    bytes = decodeBase64(bytes.toString("latin1"));
  } else if (encoding === "quoted-printable") {
    bytes = decodeQuotedPrintable(bytes.toString("latin1"));
  } else if (!encoding && !part.headers["content-type"]) {
    // No part headers at all: the bytes themselves are the only clue, and a base64 body would otherwise preview as its own encoding.
    bytes = guessEncoding(bytes);
  }
  return decodeCharset(bytes, charset);
}

/// A prefix cut mid-stream leaves an incomplete final quantum, which would poison the whole decode: only whole groups of four are kept.
function decodeBase64(text) {
  const cleaned = text.replace(/[^A-Za-z0-9+/=]/g, "");
  const whole = cleaned.slice(0, cleaned.length - (cleaned.length % 4));
  return Buffer.from(whole, "base64");
}

function decodeQuotedPrintable(text) {
  const joined = text.replace(/=\r?\n/g, "");
  const bytes = [];
  for (let index = 0; index < joined.length; index += 1) {
    const character = joined[index];
    if (character !== "=") {
      bytes.push(character.charCodeAt(0) & 0xff);
      continue;
    }
    const hex = joined.slice(index + 1, index + 3);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      index += 2;
      continue;
    }
    // A cut that landed inside an escape: drop it rather than show "=3" at the end of the preview.
    if (index + 3 > joined.length) {
      break;
    }
    bytes.push(0x3d);
  }
  return Buffer.from(bytes);
}

/// A body with no headers of its own: base64 if it looks like nothing else, quoted-printable if it carries escapes, plain otherwise.
///
/// The length rule is for the lines the encoder WRAPPED, and the last line is not one of them: it holds what was left, as short as one group of four, and a slice that stops mid line cuts it anywhere. Holding it to the rule too sent every base64 body whose tail line was short to the lock screen as its own encoding: a reply from an Android phone (text/html, base64, not multipart) was announced as "PGRpdiBkaXI9J2F1dG8n..." under a correct subject. Same rule as the app's Base64Text.looksLikeBase64; a body on ONE line still has to be long enough on its own, since a single word could be anything.
function guessEncoding(bytes) {
  const text = bytes.toString("latin1");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const wrapped = lines.length > 1 ? lines.slice(0, -1) : lines;
  const looksBase64 =
    lines.length > 0 &&
    lines.every((line) => /^[A-Za-z0-9+/=]+$/.test(line)) &&
    wrapped.every((line) => line.length >= 40);
  if (looksBase64) {
    const decoded = decodeBase64(text);
    if (decoded.length > 0) {
      return decoded;
    }
  }
  return /=[0-9A-Fa-f]{2}/.test(text) ? decodeQuotedPrintable(text) : bytes;
}

/// Bytes to text: the part's own charset, then UTF-8, then Latin-1, which never fails.
///
/// A decode that fails is retried WITHOUT its last few bytes before the next charset is reached for, because the prefix cuts where it lands: a character cut in half at its end fails the whole part, and falling through to Latin-1 for that one byte turns EVERY accent of the preview into mojibake. That is how a verification code (text/html, quoted-printable) came to be announced as "Code de vÃ©rification" for a slice that ended on "=C3=A9t=C3". Three bytes at most: no charset a message carries needs more to finish a character. Same rule as the app's RFC2047.decodeCharset (docs/DESIGN.md, "Previews").
function decodeCharset(bytes, charset) {
  const wanted = (charset ?? "utf-8").toLowerCase();
  for (const label of [wanted, "utf-8", "latin1"]) {
    for (let dropped = 0; dropped <= 3 && dropped < bytes.length; dropped += 1) {
      try {
        // fatal so a wrong charset FAILS instead of filling the preview with replacement characters.
        return new TextDecoder(label, { fatal: true }).decode(
          bytes.subarray(0, bytes.length - dropped),
        );
      } catch {
        continue;
      }
    }
  }
  return bytes.toString("latin1");
}

function looksLikeHTML(text) {
  const head = text.slice(0, 2000).toLowerCase();
  return (
    head.includes("<html") ||
    head.includes("<body") ||
    head.includes("<div") ||
    head.includes("<table") ||
    head.includes("<p>") ||
    head.includes("<br")
  );
}

/// Markup out, and only the text left: an HTML message would otherwise preview as its own stylesheet.
function plainTextFromHTML(html) {
  return html
    // The closing tag is OPTIONAL, and that is not tolerance for bad markup: this runs on a PREFIX, and a marketing template's stylesheet can outlast it, so </style> is simply not in what was read. Requiring it left the stylesheet AS the preview, which is how a message came to be announced as "@font-face { ...".
    .replace(/<(script|style|head)[\s\S]*?(?:<\/\1>|$)/gi, " ")
    .replace(/<!--[\s\S]*?(-->|$)/g, " ")
    .replace(/<\/?(br|p|div|tr|li|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    // A prefix can stop INSIDE a tag, and what is left has no closing ">" for the rule above to find: without this the preview ends on a raw '<a href="https://...' instead of on words.
    .replace(/<[^>]*$/, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z][a-z0-9]{1,9});/gi, (whole, name) => {
      const character = NAMED_ENTITIES[name];
      // An entity nobody knows is left ALONE, never dropped: "&foo;" reads as a typo of the sender's, an eaten word reads as ours.
      return character === undefined ? whole : character;
    });
}

/// Named entities, because a preview that says "15&euro; offerts d&egrave;s 129&euro;" is not a preview.
///
/// The HTML 4 latin-1 set is exactly U+00A0 to U+00FF, in order, so it is one list and one loop; the rest are the handful commercial mail actually uses (curly quotes, dashes, the euro sign). Entity names are CASE SENSITIVE in HTML ("&Eacute;" is not "&eacute;"), so they are looked up as written.
///
/// The same table lives on the app's side (HTMLText.decodeEntities): the two must agree, or the same message reads differently on the lock screen and in the list.
const LATIN1_ENTITY_NAMES = [
  // U+00A0 .. U+00BF
  "nbsp", "iexcl", "cent", "pound", "curren", "yen", "brvbar", "sect",
  "uml", "copy", "ordf", "laquo", "not", "shy", "reg", "macr",
  "deg", "plusmn", "sup2", "sup3", "acute", "micro", "para", "middot",
  "cedil", "sup1", "ordm", "raquo", "frac14", "frac12", "frac34", "iquest",
  // U+00C0 .. U+00DF
  "Agrave", "Aacute", "Acirc", "Atilde", "Auml", "Aring", "AElig", "Ccedil",
  "Egrave", "Eacute", "Ecirc", "Euml", "Igrave", "Iacute", "Icirc", "Iuml",
  "ETH", "Ntilde", "Ograve", "Oacute", "Ocirc", "Otilde", "Ouml", "times",
  "Oslash", "Ugrave", "Uacute", "Ucirc", "Uuml", "Yacute", "THORN", "szlig",
  // U+00E0 .. U+00FF
  "agrave", "aacute", "acirc", "atilde", "auml", "aring", "aelig", "ccedil",
  "egrave", "eacute", "ecirc", "euml", "igrave", "iacute", "icirc", "iuml",
  "eth", "ntilde", "ograve", "oacute", "ocirc", "otilde", "ouml", "divide",
  "oslash", "ugrave", "uacute", "ucirc", "uuml", "yacute", "thorn", "yuml",
];

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  euro: "\u20ac",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bull: "\u2022",
  trade: "\u2122",
  // Invisible on purpose, and collapse() takes them out with the rest of the padding a preheader is filled with.
  zwnj: "\u200c",
  zwj: "\u200d",
};

for (const [index, name] of LATIN1_ENTITY_NAMES.entries()) {
  NAMED_ENTITIES[name] = String.fromCodePoint(0xa0 + index);
}
// After the loop, which would otherwise make it U+00A0: a preview never wants a non breaking space, and collapse() runs over this anyway.
NAMED_ENTITIES.nbsp = " ";

/// The text up to its signature: a preview is wasted on "Envoye de mon iPhone". A message that is nothing BUT a signature keeps it, since its signature beats an empty preview.
function stripSignature(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    // "-- " exactly, trailing space and all, is the RFC 3676 delimiter; the trim above is what absorbs that space.
    const isDelimiter = trimmed === "--";
    const folded = fold(trimmed);
    if (isDelimiter || SIGNATURE_OPENERS.some((opener) => folded.startsWith(opener))) {
      const kept = lines.slice(0, index).join("\n").trim();
      return kept.length > 0 ? kept : text;
    }
  }
  return text;
}

/// Case and accents out, so "Envoyé" matches whatever the sender's client capitalized or dropped.
function fold(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/// Characters that take no room and mean nothing to a reader.
///
/// A preheader is regularly PADDED with hundreds of them (soft hyphens, zero width spaces, the combining grapheme joiner U+034F), so that the line a mail client shows stops at the offer instead of running into the body. Kept, they fill the whole preview with blanks: the reader sees one sentence and then nothing at all.
const INVISIBLE = /[\u00ad\u034f\u200b-\u200f\u2060\ufeff]/g;

function collapse(text) {
  return text.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

/// Cuts on a word boundary and SAYS it cut, ellipsis included in the cap. Prose that stops in the middle of a word with nothing to show for it reads as a bug rather than as a message that goes on.
export function abridge(text, maxLength) {
  if (text.length <= maxLength || maxLength <= 0) {
    return text;
  }
  let cut = text.slice(0, maxLength - 1);
  const space = cut.lastIndexOf(" ");
  // Unless backing up would throw away half the preview: one word two hundred characters long (a URL, a base64 blob no parser caught) is better cut through than reduced to whatever came before it.
  if (space >= Math.floor(maxLength / 2)) {
    cut = cut.slice(0, space);
  }
  return `${cut.replace(/[\s,;:.-]+$/, "")}…`;
}
