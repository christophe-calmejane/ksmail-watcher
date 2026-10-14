//
//  notifier.test.js
//  ksmail-watcher tests
//
//  What the log says when the broker does not push, because the log is the only place the owner of a Pi ever learns it: it must name the device, say what to do, never write the secret down, and not repeat itself forty times a day about a phone that was simply never set up.
//

import test from "node:test";
import assert from "node:assert/strict";
import { Notifier } from "../src/push/notifier.js";

const IPHONE = {
  name: "iPhone", installationSecret: "Q1PXYR6HAVANVEE83269J4ZZ2", encryptionKey: Buffer.alloc(32, 7),
};

function capturingLog() {
  const lines = [];
  const record = (level) => (message, fields) => lines.push({ level, message, fields: fields ?? {} });
  return {
    lines,
    error: record("error"), warn: record("warn"), info: record("info"), debug: record("debug"),
    child() { return this; },
  };
}

function notifierAnswering(...statuses) {
  const log = capturingLog();
  const answers = [...statuses];
  const notifier = new Notifier({
    broker: { notify: async () => ({ ok: answers[0] === 200, status: answers.shift() ?? 200, reason: "x" }) },
    notifications: { sound: "default", expirationSeconds: 3600, preview: "full" },
    log,
  });
  const account = { id: "perso", address: "moi@kikisoft.fr", displayName: "Perso", devices: [IPHONE] };
  const message = { mailbox: "INBOX", uid: 1, uidValidity: 1, from: { name: "Jean" }, subject: "s" };
  return { notifier, log, push: () => notifier.notifyNewMessage({ account, message }) };
}

test("a device the broker does not know is said once, by name, with the cure", async () => {
  const { log, push } = notifierAnswering(401, 401);
  await push();
  await push();
  const warnings = log.lines.filter((line) => line.level === "warn");
  assert.equal(warnings.length, 1, "once an hour, not at every message");
  assert.equal(warnings[0].fields.device, "iPhone");
  assert.match(warnings[0].message, /Settings > Push Notifications/);
});

test("the secret is never written to the log, whatever the answer", async () => {
  for (const status of [200, 401, 410, 429, 502, 0]) {
    const { log, push } = notifierAnswering(status);
    await push();
    const text = JSON.stringify(log.lines);
    assert.equal(text.includes(IPHONE.installationSecret), false, `status ${status}`);
  }
});

test("a device Apple dropped is news, not a warning: it comes back on its own", async () => {
  const { log, push } = notifierAnswering(410);
  const { sent, failed } = await push();
  assert.deepEqual({ sent, failed }, { sent: 0, failed: 1 });
  const dropped = log.lines.find((line) => /device dropped/.test(line.message));
  assert.equal(dropped.level, "info");
  assert.equal(dropped.fields.device, "iPhone");
});
