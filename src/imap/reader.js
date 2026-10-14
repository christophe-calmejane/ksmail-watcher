//
//  reader.js
//  ksmail-watcher
//
//  Turns the byte stream of an IMAP connection into LOGICAL LINES, the same shape the Swift client uses (the ksMail app's IMAP layer): a response is protocol text possibly interleaved with byte literals, where a trailing {N} announces N raw bytes that follow the CRLF and that may themselves be followed by more protocol text on the same logical line.
//
//  Reading line by line without this is the classic IMAP bug: a subject sent as a literal contains CRLFs, and a naive reader takes each of them for the end of a response.
//

const CR = 0x0d;
const LF = 0x0a;
const LITERAL_MARKER = /\{(\d+)\+?\}$/;

export class ResponseReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /// Next complete logical line, or null while the bytes for one are still missing. Segments carry the text WITHOUT the {N} marker and the literal that followed it.
  next() {
    const segments = [];
    let offset = 0;

    for (;;) {
      const crlf = this.indexOfCRLF(offset);
      if (crlf < 0) {
        return null;
      }
      const text = this.buffer.subarray(offset, crlf).toString("utf8");
      const marker = LITERAL_MARKER.exec(text);
      if (!marker) {
        segments.push({ text, literal: null });
        this.buffer = this.buffer.subarray(crlf + 2);
        return { segments };
      }

      const length = Number(marker[1]);
      const literalStart = crlf + 2;
      if (this.buffer.length < literalStart + length) {
        return null;
      }
      segments.push({
        text: text.slice(0, marker.index),
        literal: this.buffer.subarray(literalStart, literalStart + length),
      });
      offset = literalStart + length;
    }
  }

  indexOfCRLF(from) {
    for (let index = from; index + 1 < this.buffer.length; index += 1) {
      if (this.buffer[index] === CR && this.buffer[index + 1] === LF) {
        return index;
      }
    }
    return -1;
  }
}

/// The protocol text of a logical line, literals excluded. Enough for status lines, which never carry one.
export function lineText(line) {
  return line.segments.map((segment) => segment.text).join("");
}
