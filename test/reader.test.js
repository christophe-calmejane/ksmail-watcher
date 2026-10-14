//
//  reader.test.js
//  ksmail-watcher tests
//
//  Why this exists: every IMAP client that reads the wire line by line works until the first subject with an accent in it, because such a subject arrives as a byte literal whose content may contain CRLF. These tests pin the one behavior that keeps that from happening.
//

import test from "node:test";
import assert from "node:assert/strict";
import { ResponseReader, lineText } from "../src/imap/reader.js";

test("a plain line is complete as soon as its CRLF arrives", () => {
  const reader = new ResponseReader();
  reader.push(Buffer.from("* OK ready\r\n"));
  const line = reader.next();
  assert.equal(lineText(line), "* OK ready");
  assert.equal(reader.next(), null);
});

test("a line is not returned before its CRLF", () => {
  const reader = new ResponseReader();
  reader.push(Buffer.from("* OK re"));
  assert.equal(reader.next(), null);
  reader.push(Buffer.from("ady\r\n"));
  assert.equal(lineText(reader.next()), "* OK ready");
});

test("a literal is read as bytes and not as protocol text", () => {
  const reader = new ResponseReader();
  reader.push(Buffer.from('* 1 FETCH (SUBJECT {6}\r\nab\r\ncd ) END\r\n'));
  const line = reader.next();
  assert.equal(line.segments.length, 2);
  assert.equal(line.segments[0].literal.toString(), "ab\r\ncd");
  assert.equal(lineText(line), "* 1 FETCH (SUBJECT  ) END");
});

test("a literal split across two reads waits for all of its bytes", () => {
  const reader = new ResponseReader();
  reader.push(Buffer.from("* 1 FETCH (SUBJECT {6}\r\nabc"));
  assert.equal(reader.next(), null);
  reader.push(Buffer.from("def)\r\n"));
  const line = reader.next();
  assert.equal(line.segments[0].literal.toString(), "abcdef");
});

test("two literals on one logical line both come back", () => {
  const reader = new ResponseReader();
  reader.push(Buffer.from("* 1 FETCH (A {2}\r\nxy B {3}\r\nzzz)\r\n"));
  const line = reader.next();
  assert.deepEqual(
    line.segments.map((segment) => segment.literal?.toString() ?? null),
    ["xy", "zzz", null],
  );
});

test("several lines arriving in one packet come back one by one", () => {
  const reader = new ResponseReader();
  reader.push(Buffer.from("* 1 EXISTS\r\n* 2 RECENT\r\nK1 OK done\r\n"));
  assert.equal(lineText(reader.next()), "* 1 EXISTS");
  assert.equal(lineText(reader.next()), "* 2 RECENT");
  assert.equal(lineText(reader.next()), "K1 OK done");
  assert.equal(reader.next(), null);
});
