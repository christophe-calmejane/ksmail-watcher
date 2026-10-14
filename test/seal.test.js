//
//  seal.test.js
//  ksmail-watcher tests
//
//  Two promises, and neither shows when it is broken:
//
//  1. Nothing that names a message travels in clear. The broker and Apple see a generic alert and a blob; a field left outside the seal is a field they read, and no screen anywhere would say so.
//  2. The app opens what this side seals. It is a CROSS LANGUAGE contract (the ksMail app's SealedNotification.swift), so it is pinned to a vector both sides assert: get the nonce order or the additional data wrong and every banner says "New Message".
//

import test from "node:test";
import assert from "node:assert/strict";
import {
  sealNotification, sealBytes, openBytes, sealedCollapseId, parseEncryptionKey,
  GENERIC_TITLE_LOC_KEY, MAX_PAYLOAD_BYTES,
} from "../src/push/seal.js";
import { buildNewMailPayload, buildWatcherAlertPayload } from "../src/push/payload.js";

/// The vector, shared with the ksMail app's SealedNotificationTests: the key is the bytes 0 to 31, the nonce the bytes 0 to 11.
const KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const NONCE = Buffer.from(Array.from({ length: 12 }, (_, index) => index));
const PLAINTEXT = '{"alert":{"title":"Jean Dupont","body":"Réunion à 10h"},"ksmail":{"v":1,"kind":"newMessage"}}';
const SEALED = "AAECAwQFBgcICQoLPCC3d6CXtjm3OrX/2J0UCKHspX6VGjFcfBKV6nMdIp4jcsGY1uMouiZn1pjm7kdWzprArWvmy/hCuwhya46Uh5we/AHxpwRbLXiIBYbhasoCqKcHAS42G46c+alajcQ9Eq2LWoFBgbvnHjZckeO9";

test("the seal is the one the app opens", () => {
  assert.equal(sealBytes(KEY, Buffer.from(PLAINTEXT, "utf8"), NONCE), SEALED);
  assert.equal(openBytes(KEY, SEALED).toString("utf8"), PLAINTEXT);
});

test("the key is read the way ksMail shows it, and in plain base64 too", () => {
  assert.deepEqual(parseEncryptionKey("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"), KEY);
  assert.deepEqual(parseEncryptionKey(KEY.toString("base64")), KEY);
  assert.equal(parseEncryptionKey("AAECAwQF"), null, "too short");
  assert.equal(parseEncryptionKey("not a key at all, not even close to one!!!"), null);
  assert.equal(parseEncryptionKey(undefined), null);
});

const ACCOUNT = { id: "perso", address: "moi@kikisoft.fr", displayName: "Perso" };
const MESSAGE = {
  mailbox: "INBOX", uid: 4567, uidValidity: 42, messageId: "<abc@exemple.fr>",
  subject: "Réunion de lundi", from: { name: "Jean Dupont", address: "jean@exemple.fr" },
  preview: "Bonjour, la réunion est décalée à 10h.", date: new Date("2026-09-05T10:34:56Z"),
};

test("what names the message is sealed, and only a generic alert stays in clear", () => {
  const clear = buildNewMailPayload({ account: ACCOUNT, message: MESSAGE });
  const { payload, collapseId } = sealNotification({ payload: clear, collapseId: "perso.4567", key: KEY });

  const visible = JSON.stringify(payload);
  for (const secret of ["Jean", "jean@exemple.fr", "Réunion", "moi@kikisoft.fr", "perso", "4567", "abc@exemple.fr"]) {
    assert.equal(visible.includes(secret), false, `"${secret}" travels in clear`);
  }
  assert.deepEqual(payload.aps, {
    alert: { "title-loc-key": GENERIC_TITLE_LOC_KEY },
    sound: "default",
    category: "NEW_MAIL",
    "content-available": 1,
    "mutable-content": 1,
  });
  assert.equal(payload.ksmail.v, 2);

  const inner = JSON.parse(openBytes(KEY, payload.ksmail.sealed).toString("utf8"));
  assert.deepEqual(inner.alert, clear.aps.alert);
  assert.equal(inner["thread-id"], "perso");
  assert.deepEqual(inner.ksmail, clear.ksmail, "the app gets the v1 block back, untouched");

  assert.match(collapseId, /^[0-9a-f]{32}$/);
  assert.equal(collapseId, sealedCollapseId(KEY, "perso.4567"), "the same message, the same id");
  assert.equal(sealedCollapseId(KEY, "perso.4567"), "87aff8a720e6221fcd6773ff9891e54d");
});

test("two seals of the same notification never look alike", () => {
  const clear = buildNewMailPayload({ account: ACCOUNT, message: MESSAGE });
  const first = sealNotification({ payload: clear, key: KEY }).payload.ksmail.sealed;
  const second = sealNotification({ payload: clear, key: KEY }).payload.ksmail.sealed;
  assert.notEqual(first, second, "a fresh nonce every time");
});

/// The watcher's own alert keeps its localization keys in clear: they are the same sentence for everybody. The account it names does not.
test("the watcher alert keeps its sentence in clear and seals the account", () => {
  const clear = buildWatcherAlertPayload({ account: ACCOUNT, reason: "oauthExpired" });
  const { payload } = sealNotification({ payload: clear, key: KEY });
  assert.equal(payload.aps.alert["title-loc-key"], "Push notifications stopped");
  assert.match(payload.aps.alert["loc-key"], /authorization has expired/);
  assert.equal(payload.aps.alert.subtitle, undefined);
  assert.equal(JSON.stringify(payload).includes("Perso"), false);
  const inner = JSON.parse(openBytes(KEY, payload.ksmail.sealed).toString("utf8"));
  assert.equal(inner.alert.subtitle, "Perso");
  assert.equal(inner.ksmail.reason, "oauthExpired");
});

/// Sealing costs a third (base64) plus the nonce and the tag, and a subject in a script of three bytes a character can then push the payload past what APNs accepts. The texts are cut, the body first.
test("a sealed payload always fits in what APNs accepts", () => {
  const heavy = buildNewMailPayload({
    account: ACCOUNT,
    message: { ...MESSAGE, subject: "会議".repeat(200), preview: "会議の時間が変更されました。".repeat(100), from: { name: "山田".repeat(100), address: "y@e.jp" } },
  });
  const { payload } = sealNotification({ payload: heavy, key: KEY });
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= MAX_PAYLOAD_BYTES);
  const inner = JSON.parse(openBytes(KEY, payload.ksmail.sealed).toString("utf8"));
  assert.ok(inner.alert.title, "the sender survives");
  assert.ok(inner.ksmail.uid === 4567, "the block the app acts on survives whole");
});
