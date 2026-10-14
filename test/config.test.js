//
//  config.test.js
//  ksmail-watcher tests
//
//  Why this exists: every field checked here is one the watcher cannot invent at three in the morning. A mistyped secret or a device name nobody listed has to stop the process at startup with a sentence, not produce a service that runs for a month and has never pushed anything.
//

import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";
import { DEFAULT_BROKER_URL } from "../src/push/broker.js";
import { buildNewMailPayload, senderTitle, newMailDelivery } from "../src/push/payload.js";

/// Two devices as ksMail copies them for the watcher.
const IPHONE_SECRET = "Q1PXY-R6HAV-ANVEE-83269-J4ZZ2";
const MAC_SECRET = "6HFQ4-EAD59-018N6-41JBH-V5SJR";
const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const IPHONE = { installationSecret: IPHONE_SECRET, encryptionKey: KEY };
const MAC = { installationSecret: MAC_SECRET, encryptionKey: KEY };

const MINIMAL = {
  accounts: [{ id: "perso", address: "Moi@Kikisoft.FR", host: "imap.free.fr", auth: { type: "password", password: "x" } }],
  broker: { url: "https://ksmail-broker.example.workers.dev/", devices: { iPhone: IPHONE } },
};

test("an account gets the defaults every provider ksMail targets uses", () => {
  const config = parseConfig(MINIMAL, { baseDirectory: "/etc/ksmail-watcher" });
  const account = config.accounts[0];
  assert.equal(account.port, 993);
  assert.equal(account.tls, true);
  assert.deepEqual(account.mailboxes, ["INBOX"]);
  // The address is the key the app matches a push on, so it is stored folded to lower case, and the login defaults to it.
  assert.equal(account.address, "moi@kikisoft.fr");
  assert.equal(account.username, "moi@kikisoft.fr");
  assert.equal(config.notifications.preview, "full");
  assert.equal(config.notifications.expirationSeconds, 3600);
});

test("the broker's devices are kept by name, their secrets normalized as the broker reads them", () => {
  const config = parseConfig({
    ...MINIMAL,
    broker: {
      url: "https://b.example/",
      devices: { iPhone: { ...IPHONE, installationSecret: "q1pxy r6hav anvee 83269 j4zz2" }, Mac: MAC },
    },
  });
  assert.equal(config.broker.url, "https://b.example", "no trailing slash, so paths can be appended");
  assert.deepEqual(config.broker.devices.map(({ name, installationSecret }) => ({ name, installationSecret })), [
    { name: "iPhone", installationSecret: "Q1PXYR6HAVANVEE83269J4ZZ2" },
    { name: "Mac", installationSecret: "6HFQ4EAD59018N641JBHV5SJR" },
  ]);
  assert.equal(config.broker.devices[0].encryptionKey.length, 32);
  assert.deepEqual(config.accounts[0].devices, config.broker.devices, "no list means every device");
});

/// The app's contract (doc/ajout-d-un-compte.md 3.1 in the ksMail repository): Google shows the sixteen letters in four groups, a copy brings the spaces along, and they are not part of the password.
test("a Gmail app password loses its spaces, and no other password does", () => {
  const gmail = parseConfig({
    ...MINIMAL,
    accounts: [{ id: "g", address: "me@gmail.com", host: "imap.gmail.com", auth: { type: "password", password: "abcd efgh\u00a0ijkl mnop" } }],
  });
  assert.equal(gmail.accounts[0].auth.password, "abcdefghijklmnop");
  const other = parseConfig({
    ...MINIMAL,
    accounts: [{ id: "o", address: "me@free.fr", host: "imap.free.fr", auth: { type: "password", password: "a pass phrase" } }],
  });
  assert.equal(other.accounts[0].auth.password, "a pass phrase");
});

/// Nearly every watcher sends to the broker of the App Store ksMail: a configuration written by hand does not have to know its address.
test("a configuration that names no broker sends to the one the App Store ksMail registers with", () => {
  const config = parseConfig({ ...MINIMAL, broker: { devices: { iPhone: IPHONE } } });
  assert.equal(config.broker.url, "https://ksmail-broker.kikisoft.com");
  assert.equal(config.broker.url, DEFAULT_BROKER_URL);
});

/// A secret mistyped in the file would be answered 401 at every mail, in a log nobody reads. It is cheaper to refuse it here.
test("something that is not an installation secret is refused, naming the device", () => {
  assert.throws(
    () => parseConfig({ ...MINIMAL, broker: { ...MINIMAL.broker, devices: { iPhone: { ...IPHONE, installationSecret: "ABCD-EFGH-JKMN-PQRS" } } } }),
    /broker\.devices\.iPhone\.installationSecret is not an installation secret/,
  );
  assert.throws(
    () => parseConfig({ ...MINIMAL, broker: { ...MINIMAL.broker, devices: { iPhone: { ...IPHONE, encryptionKey: "short" } } } }),
    /broker\.devices\.iPhone\.encryptionKey is not an encryption key/,
  );
  // A secret alone is the shape of the first broker version: every notification is sealed now, and a device without its key cannot be.
  assert.throws(
    () => parseConfig({ ...MINIMAL, broker: { ...MINIMAL.broker, devices: { iPhone: IPHONE_SECRET } } }),
    /must be \{ "installationSecret": \.\.\., "encryptionKey": \.\.\. \}/,
  );
  assert.throws(
    () => parseConfig({ ...MINIMAL, broker: { ...MINIMAL.broker, devices: {} } }),
    /broker\.devices must name at least one device/,
  );
  assert.throws(
    () => parseConfig({ ...MINIMAL, broker: { ...MINIMAL.broker, devices: { a: IPHONE, b: { ...IPHONE, installationSecret: IPHONE_SECRET.toLowerCase() } } } }),
    /hold the same secret/,
  );
});

/// The secrets go over this connection: plain HTTP is for this machine only, which is the tests and a broker under "wrangler dev".
test("the broker is reached over https, or over http on this machine only", () => {
  assert.throws(() => parseConfig({ ...MINIMAL, broker: { ...MINIMAL.broker, url: "http://broker.example" } }), /https/);
  assert.throws(() => parseConfig({ ...MINIMAL, broker: { ...MINIMAL.broker, url: "not a url" } }), /not a URL/);
  assert.equal(parseConfig({ ...MINIMAL, broker: { ...MINIMAL.broker, url: "http://127.0.0.1:8787" } }).broker.url,
    "http://127.0.0.1:8787");
  assert.throws(() => parseConfig({ ...MINIMAL, broker: undefined }), /broker is required/);
});

/// One watcher for a household: each person's account names that person's devices, and the account everybody shares names none.
test("an account is pushed to the devices it names, and a name nobody listed is refused", () => {
  const config = parseConfig({
    ...MINIMAL,
    broker: { url: "https://b.example", devices: { "iphone-papa": IPHONE, "iphone-maman": MAC } },
    accounts: [
      { id: "papa", address: "papa@kikisoft.fr", host: "h", auth: { type: "password", password: "x" }, devices: ["iphone-papa"] },
      { id: "commun", address: "maison@kikisoft.fr", host: "h", auth: { type: "password", password: "x" } },
    ],
  });
  assert.deepEqual(config.accounts[0].devices.map((device) => device.name), ["iphone-papa"]);
  assert.deepEqual(config.accounts[1].devices.map((device) => device.name), ["iphone-papa", "iphone-maman"]);

  assert.throws(
    () => parseConfig({ ...MINIMAL, accounts: [{ ...MINIMAL.accounts[0], devices: ["iPad"] }] }),
    /perso names the device "iPad", which broker\.devices does not list/,
  );
  assert.throws(
    () => parseConfig({ ...MINIMAL, accounts: [{ ...MINIMAL.accounts[0], devices: [] }] }),
    /pushes this account to nobody/,
  );
});

/// The watcher this one replaces talked to Apple and to CloudKit itself. A file still carrying those sections is refused with the way out, rather than read as if nothing had changed: one of them points at the Apple key, which must leave this machine.
test("a configuration of the watcher that held the Apple key is refused with what to do", () => {
  assert.throws(
    () => parseConfig({ ...MINIMAL, apns: { keyFile: "AuthKey.p8", preview: "full" } }),
    /the apns section is gone.*"notifications" section/,
  );
  assert.throws(
    () => parseConfig({ ...MINIMAL, devices: { source: "cloudkit" } }),
    /the devices section is gone.*broker\.devices/,
  );
});

test("the state file is resolved against the configuration file", () => {
  const config = parseConfig(MINIMAL, { baseDirectory: "/etc/ksmail-watcher" });
  assert.equal(config.stateFile, "/etc/ksmail-watcher/state/state.json");
});

test("a missing field is named in the error, not just refused", () => {
  assert.throws(
    () => parseConfig({ ...MINIMAL, accounts: [{ id: "perso", host: "h", auth: { type: "password", password: "x" } }] }),
    /accounts\[0\].address/,
  );
  assert.throws(() => parseConfig({ ...MINIMAL, broker: { ...MINIMAL.broker, url: "" } }), /broker\.url/);
  assert.throws(
    () => parseConfig({ ...MINIMAL, notifications: { preview: "everything" } }),
    /notifications\.preview/,
  );
});

test("two accounts cannot share an id, because the state file keys on it", () => {
  assert.throws(
    () => parseConfig({ ...MINIMAL, accounts: [MINIMAL.accounts[0], MINIMAL.accounts[0]] }),
    /share the id perso/,
  );
});

test("an oauth account needs the three things a refresh takes", () => {
  assert.throws(
    () => parseConfig({
      ...MINIMAL,
      accounts: [{ id: "gmail", address: "a@gmail.com", host: "imap.gmail.com", auth: { type: "oauth", provider: "google" } }],
    }),
    /clientId/,
  );
});

/// "ksmail-watcher oauth --account" puts the token in the state file, so the configuration is allowed to have none: the check that one exists somewhere is done at startup, where the state file is known.
test("an oauth account may leave the refresh token to the state file", () => {
  const config = parseConfig({
    ...MINIMAL,
    accounts: [{
      id: "gmail", address: "a@gmail.com", host: "imap.gmail.com",
      auth: { type: "oauth", provider: "google", clientId: "c", clientSecret: "s" },
    }],
  });
  assert.equal(config.accounts[0].auth.refreshToken, null);
});

/// Sender, subject, then a line of the message, which is how Mail and Gmail lay a mail notification out. The account name is deliberately absent: it used to take the subtitle, the second bold line, to say the one thing the reader already knew.
test("the lock screen carries the sender, the subject and a line of the message", () => {
  const payload = buildNewMailPayload({
    account: { id: "perso", address: "moi@kikisoft.fr", displayName: "Perso" },
    message: {
      mailbox: "INBOX", uid: 12, uidValidity: 42, messageId: "<a@b>",
      subject: "Réunion", from: { name: "Jean", address: "jean@exemple.fr" },
      preview: "Elle est décalée à 10h, salle Vézère.",
      date: new Date("2026-09-05T10:00:00Z"),
    },
  });
  assert.deepEqual(payload.aps.alert, {
    title: "Jean",
    subtitle: "Réunion",
    body: "Elle est décalée à 10h, salle Vézère.",
  });
  assert.equal(payload.aps["thread-id"], "perso");
  assert.equal(payload.ksmail.v, 1);
  // Asks the system to wake the APP too, so the message is in the list before the banner is tapped. A contract with the client: without it, ksMail hears of the message only on the tap and the tap then waits on an IMAP connection.
  assert.equal(payload.aps["content-available"], 1);
  assert.equal(payload.ksmail.uid, 12);
  assert.equal(payload.ksmail.date, "2026-09-05T10:00:00.000Z");
});

test("the subject level sends the subject and not one word of the message", () => {
  const payload = buildNewMailPayload({
    account: { id: "perso", address: "moi@kikisoft.fr", displayName: "Perso" },
    message: {
      mailbox: "INBOX", uid: 1, subject: "Réunion",
      from: { name: "Jean", address: "j@e.fr" },
      preview: "Confidentiel",
    },
    preview: "subject",
  });
  assert.equal(payload.aps.alert.subtitle, "Réunion");
  assert.equal(payload.aps.alert.body, undefined);
  assert.equal(JSON.stringify(payload).includes("Confidentiel"), false);
});

test("senderOnly leaves the subject on the Pi as well", () => {
  const payload = buildNewMailPayload({
    account: { id: "perso", address: "moi@kikisoft.fr", displayName: "Perso" },
    message: {
      mailbox: "INBOX", uid: 1, subject: "Confidentiel",
      from: { name: "Jean", address: "j@e.fr" },
      preview: "Secret",
    },
    preview: "senderOnly",
  });
  assert.equal(payload.aps.alert.subtitle, undefined);
  assert.equal(payload.aps.alert.body, undefined);
  assert.equal(JSON.stringify(payload).includes("Confidentiel"), false);
  assert.equal(JSON.stringify(payload).includes("Secret"), false);
});

/// Both texts are written by someone else, so both are cut here: APNs refuses a payload over 4 KB, and a message ending on a 900 character subject would be the one that finds out.
test("a sender with no name is named by their address, and both texts are cut", () => {
  assert.equal(senderTitle({ name: null, address: "jean@exemple.fr" }), "jean@exemple.fr");
  const payload = buildNewMailPayload({
    account: { id: "a", address: "a@b.fr", displayName: "A" },
    message: {
      mailbox: "INBOX", uid: 1, subject: "x".repeat(900),
      from: { name: "Jean", address: "j@e.fr" },
      preview: "y".repeat(900),
    },
  });
  assert.equal(payload.aps.alert.subtitle.length, 120);
  assert.equal(payload.aps.alert.body.length, 400);
  assert.ok(JSON.stringify(payload).length < 4096, "APNs refuses a payload over 4 KB");
});

/// Apple counts a collapse id in bytes, and so does the broker, which refuses one over 64: an account id with accents must be cut on a character, under the limit, and never refused.
test("a collapse id is cut to 64 bytes, not 64 characters", () => {
  const delivery = newMailDelivery({
    account: { id: "é".repeat(40) }, message: { uid: 12 }, expirationSeconds: 3600,
  });
  assert.ok(new TextEncoder().encode(delivery.collapseId).length <= 64);
  assert.equal(delivery.collapseId, "é".repeat(32));
  assert.equal(delivery.expiresIn, 3600);
});
