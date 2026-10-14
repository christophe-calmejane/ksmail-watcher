//
//  rfc2047.js
//  ksmail-watcher
//
//  Decodes encoded words ("=?UTF-8?B?...?=") in a header value. A push whose title reads "=?UTF-8?Q?R=C3=A9union?=" is a bug the owner sees on the lock screen, so this runs on every subject and every sender name before they leave the Pi.
//
//  The app has the same decoder in Swift (Core/Mail/Parsing/RFC2047). This one is deliberately the small version: it decodes, it never re-encodes, and anything it does not understand is passed through unchanged rather than replaced by an error.
//

const ENCODED_WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

function decodeBytes(bytes, charset) {
  const name = charset.toLowerCase().split("*")[0];
  if (name === "utf-8" || name === "utf8" || name === "us-ascii" || name === "ascii") {
    return bytes.toString("utf8");
  }
  if (name === "iso-8859-1" || name === "latin1" || name === "windows-1252" || name === "cp1252") {
    // Close enough for a notification title: the two differ only on the 0x80-0x9F range, and Buffer knows latin1 without ICU.
    return bytes.toString("latin1");
  }
  try {
    return new TextDecoder(name).decode(bytes);
  } catch {
    return bytes.toString("latin1");
  }
}

function decodeQuotedPrintableWord(text) {
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "_") {
      bytes.push(0x20);
    } else if (character === "=" && index + 2 < text.length) {
      const hex = text.slice(index + 1, index + 3);
      const value = Number.parseInt(hex, 16);
      if (Number.isNaN(value)) {
        bytes.push(character.charCodeAt(0));
      } else {
        bytes.push(value);
        index += 2;
      }
    } else {
      bytes.push(character.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export function decodeHeaderText(value) {
  if (!value || !value.includes("=?")) {
    return value ?? "";
  }
  // Whitespace BETWEEN two encoded words is not part of the text (RFC 2047 section 6.2): "=?..?=  =?..?=" is one word split in two.
  const joined = value.replace(/\?=\s+=\?/g, "?==?");
  return joined.replace(ENCODED_WORD, (whole, charset, encoding, payload) => {
    try {
      const bytes = encoding.toUpperCase() === "B"
        ? Buffer.from(payload, "base64")
        : decodeQuotedPrintableWord(payload);
      return decodeBytes(bytes, charset);
    } catch {
      return whole;
    }
  });
}
