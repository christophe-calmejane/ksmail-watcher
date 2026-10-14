//
//  parse.test.js
//  ksmail-watcher tests
//
//  Why this exists: what these functions return IS the notification. A subject left as "=?UTF-8?B?..." or an INTERNALDATE misread by two hours does not crash anything, it just puts nonsense on a lock screen or silently classes fresh mail as too old to announce.
//

import test from "node:test";
import assert from "node:assert/strict";
import { ResponseReader } from "../src/imap/reader.js";
import { parseFetch, parseInternalDate, responseCode, selectSummary } from "../src/imap/parse.js";
import { decodeHeaderText } from "../src/imap/rfc2047.js";
import { encodeMailboxName } from "../src/imap/mailboxname.js";

function fetchLine(text) {
  const reader = new ResponseReader();
  reader.push(Buffer.from(text, "utf8"));
  return reader.next();
}

test("a FETCH gives its uid, its flags and its envelope", () => {
  const line = fetchLine(
    '* 12 FETCH (UID 4567 FLAGS (\\Seen NonJunk) INTERNALDATE "05-Sep-2026 12:34:56 +0200" ' +
    'ENVELOPE ("Sat, 5 Sep 2026 12:34:56 +0200" "Hello" ' +
    '(("Jean Dupont" NIL "jean" "exemple.fr")) NIL NIL ((NIL NIL "moi" "kikisoft.fr")) ' +
    'NIL NIL NIL "<abc@exemple.fr>"))\r\n',
  );
  const item = parseFetch(line);
  assert.equal(item.uid, 4567);
  assert.deepEqual(item.flags, ["\\Seen", "NonJunk"]);
  assert.equal(item.envelope.subject, "Hello");
  assert.deepEqual(item.envelope.from[0], { name: "Jean Dupont", address: "jean@exemple.fr" });
  assert.equal(item.envelope.messageId, "<abc@exemple.fr>");
});

test("a subject sent as a literal is decoded, encoded words included", () => {
  const subject = "=?UTF-8?Q?R=C3=A9union_de_lundi?=";
  const line = fetchLine(
    `* 3 FETCH (UID 9 FLAGS () ENVELOPE ("Sat, 5 Sep 2026 12:00:00 +0200" {${subject.length}}\r\n` +
    `${subject} ((NIL NIL "jean" "exemple.fr")) NIL NIL NIL NIL NIL NIL NIL))\r\n`,
  );
  assert.equal(parseFetch(line).envelope.subject, "Réunion de lundi");
});

test("a sender with no display name is named by their address", () => {
  const line = fetchLine(
    '* 1 FETCH (UID 1 FLAGS () ENVELOPE (NIL "x" ((NIL NIL "jean" "exemple.fr")) NIL NIL NIL NIL NIL NIL NIL))\r\n',
  );
  assert.deepEqual(parseFetch(line).envelope.from[0], { name: null, address: "jean@exemple.fr" });
});

test("anything that is not a FETCH is not mistaken for one", () => {
  assert.equal(parseFetch(fetchLine("* 4 EXISTS\r\n")), null);
  assert.equal(parseFetch(fetchLine("* OK [UIDNEXT 12] predicted\r\n")), null);
});

test("SELECT tells the mailbox apart by its uidvalidity and its top uid", () => {
  const reader = new ResponseReader();
  reader.push(Buffer.from(
    "* 17 EXISTS\r\n* OK [UIDVALIDITY 42] uidvalidity\r\n* OK [UIDNEXT 4568] predicted\r\n" +
    "* OK [PERMANENTFLAGS (\\Seen \\*)] limited\r\n",
  ));
  const untagged = [reader.next(), reader.next(), reader.next(), reader.next()];
  const summary = selectSummary(untagged, "[READ-ONLY] EXAMINE done");
  assert.equal(summary.exists, 17);
  assert.equal(summary.uidValidity, 42);
  assert.equal(summary.uidNext, 4568);
  assert.equal(summary.readOnly, true);
  assert.deepEqual(summary.permanentFlags, ["\\Seen", "\\*"]);
});

test("a response code is read whatever follows it", () => {
  assert.deepEqual(responseCode("* OK [UIDNEXT 4568] Predicted next UID"), { name: "UIDNEXT", arguments: "4568" });
  assert.equal(responseCode("* OK nothing in brackets"), null);
});

test("INTERNALDATE is read with its own format and its own zone", () => {
  assert.equal(
    parseInternalDate("05-Sep-2026 12:34:56 +0200").toISOString(),
    "2026-09-05T10:34:56.000Z",
  );
  assert.equal(
    parseInternalDate("31-Dec-2025 23:00:00 -0500").toISOString(),
    "2026-01-01T04:00:00.000Z",
  );
  assert.equal(parseInternalDate("not a date"), null);
});

test("encoded words are decoded, in both encodings and both charsets", () => {
  assert.equal(decodeHeaderText("=?UTF-8?B?Q29uZ8Okw59l?="), "Congäße");
  assert.equal(decodeHeaderText("=?ISO-8859-1?Q?R=E9union?="), "Réunion");
  // Whitespace between two encoded words is not part of the text.
  assert.equal(decodeHeaderText("=?UTF-8?Q?Deux_?= =?UTF-8?Q?mots?="), "Deux mots");
  // Anything else goes through untouched, including a lone question mark.
  assert.equal(decodeHeaderText("Plain subject?"), "Plain subject?");
});

test("a mailbox name with an accent goes on the wire in modified UTF-7", () => {
  // What Free.fr calls its junk folder, and what the app stores.
  assert.equal(encodeMailboxName("INBOX.Indésirables"), "INBOX.Ind&AOk-sirables");
  assert.equal(encodeMailboxName("[Gmail]/Messages envoyés"), "[Gmail]/Messages envoy&AOk-s");
  // An ASCII name is left exactly as it is, so a name copied from a server listing (already encoded) still works in the configuration.
  assert.equal(encodeMailboxName("INBOX"), "INBOX");
  assert.equal(encodeMailboxName("INBOX.Ind&AOk-sirables"), "INBOX.Ind&AOk-sirables");
  // In a name that does need encoding, a literal ampersand is "&-".
  assert.equal(encodeMailboxName("Reçus & envoyés"), "Re&AOc-us &- envoy&AOk-s");
});
