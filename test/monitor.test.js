//
//  monitor.test.js
//  ksmail-watcher tests
//
//  Why this exists: this is the whole component, end to end, with a fake IMAP server and a fake broker. Every rule about what deserves a notification lives in the monitor, and every one of them fails SILENTLY when it is wrong: a wrong starting point pushes a hundred old messages, a wrong flag test pushes mail already read on the Mac, and a wrong UID comparison pushes nothing at all and looks exactly like a working watcher on an empty mailbox.
//

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeImapServer } from "./fake-imap-server.js";
import { FakeBrokerServer } from "./fake-broker-server.js";
import { BrokerClient } from "../src/push/broker.js";
import { Notifier } from "../src/push/notifier.js";
import { openBytes, sealedCollapseId } from "../src/push/seal.js";
import { MailboxMonitor } from "../src/imap/monitor.js";
import { DEEP_PREFIX_BYTES, PREFIX_BYTES } from "../src/imap/snippet.js";
import { OAuthError } from "../src/oauth.js";
import { State } from "../src/state.js";
import { logger, setLogLevel } from "../src/log.js";

setLogLevel("error");
const quietLog = logger("test");

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "ksmail-monitor-"));
}

function nowInternalDate(offsetHours = 0) {
  const date = new Date(Date.now() - offsetHours * 3600 * 1000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getUTCDate())}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

async function waitFor(condition, { timeoutMs = 5000, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/// Two devices as broker.devices lists them, secrets normalized.
const IPHONE = {
  name: "iPhone", installationSecret: "Q1PXYR6HAVANVEE83269J4ZZ2", encryptionKey: Buffer.alloc(32, 1),
};
const MAC = {
  name: "Mac", installationSecret: "6HFQ4EAD59018N641JBHV5SJR", encryptionKey: Buffer.alloc(32, 2),
};

/// What the device shows once its extension has opened the seal: the payload as the watcher built it, before it was sealed for that device. The broker itself only ever sees the sealed one.
function clearPayload(request) {
  const device = [IPHONE, MAC].find((entry) => entry.installationSecret === request.body.installationSecret);
  const sealed = request.body.payload;
  const inner = JSON.parse(openBytes(device.encryptionKey, sealed.ksmail.sealed).toString("utf8"));
  // The generic title is what the seal stands in for; a localization key of the watcher's own (its alert) is what it really said.
  const { "title-loc-key": generic, ...localized } = sealed.aps.alert;
  const shown = generic === "New Message" ? localized : sealed.aps.alert;
  const aps = { ...sealed.aps, alert: { ...shown, ...inner.alert } };
  if (inner["thread-id"] !== undefined) {
    aps["thread-id"] = inner["thread-id"];
  }
  return { aps, ksmail: inner.ksmail };
}

const WATCH_CONFIG = {
  pollSeconds: 1,
  maxCatchUpPerMailbox: 5,
  catchUpMaxAgeHours: 12,
  // The default, and the one level that makes the watcher ask a server for a body prefix at all.
  notifications: { preview: "full" },
};

const ACCOUNT = {
  id: "perso",
  address: "moi@kikisoft.fr",
  displayName: "Perso",
  username: "user",
  auth: { type: "password", password: "secret" },
};

/// Builds the whole chain around one fake IMAP server: state file, broker client pointed at the fake, the account's devices, one monitor.
async function harness(
  imap,
  { stateSeed = null, preview = "full", devices = [IPHONE], account = ACCOUNT, auth = null } = {},
) {
  const directory = temporaryDirectory();
  const broker = new FakeBrokerServer();
  const url = await broker.start();
  const port = await imap.start();

  const state = new State(join(directory, "state.json"), quietLog);
  if (stateSeed) {
    state.data.mailboxes = stateSeed;
  }
  const notifier = new Notifier({
    broker: new BrokerClient({ url, log: quietLog }),
    notifications: { sound: "default", expirationSeconds: 3600, preview },
    log: quietLog,
  });
  const monitorFor = (mailbox) => new MailboxMonitor({
    // The devices are the ACCOUNT's, which is what lets one watcher push each member of a household only their own mail.
    account: {
      ...account, host: "127.0.0.1", port, tls: false, mailboxes: ["INBOX"], devices,
    },
    mailbox,
    auth,
    config: { ...WATCH_CONFIG, notifications: { preview } },
    state,
    log: quietLog,
    notifier,
  });
  const monitor = monitorFor("INBOX");

  const stop = async () => {
    monitor.stop();
    await broker.stop();
    await imap.stop();
  };
  return { monitor, monitorFor, state, broker, stop };
}

test("a message that arrives while the watcher is idling becomes a push", async () => {
  const imap = new FakeImapServer({
    messages: [{ uid: 10, flags: [], internalDate: nowInternalDate(2), subject: "Ancien", from: { name: "Vieux", address: "vieux@exemple.fr" } }],
  });
  const { monitor, broker, stop } = await harness(imap);
  monitor.run();

  await waitFor(() => monitor.status.connected, { what: "the monitor to be watching" });
  assert.equal(broker.notifications.length, 0, "what was already there is not news");

  imap.deliver({
    uid: 11,
    flags: [],
    internalDate: nowInternalDate(0),
    subject: "Réunion de lundi",
    from: { name: "Jean Dupont", address: "jean@exemple.fr" },
    messageId: "<11@exemple.fr>",
    body: "Bonjour,\r\nla réunion est décalée à 10h.\r\n",
  });

  await waitFor(() => broker.notifications.length === 1, { what: "the push" });
  const request = broker.notifications[0];
  // The device is named by its installation secret: the watcher never learns a device token, the broker puts it in the request to Apple.
  assert.equal(request.path, "/notify");
  assert.equal(request.body.installationSecret, IPHONE.installationSecret);
  // The two fields the broker turns into apns-collapse-id and apns-expiration. The rest of the headers are the broker's. Sealed too: the header Apple and the broker see says nothing of the account or the UID, and is the same for the same message.
  assert.equal(request.body.collapseId, sealedCollapseId(IPHONE.encryptionKey, "perso.11"));
  assert.equal(request.body.expiresIn, 3600);
  // Sender, subject, then a line of the message: the layout Mail and Gmail use, and the account name is deliberately not on it.
  assert.equal(clearPayload(request).aps.alert.title, "Jean Dupont");
  assert.equal(clearPayload(request).aps.alert.subtitle, "Réunion de lundi");
  assert.equal(clearPayload(request).aps.alert.body, "Bonjour, la réunion est décalée à 10h.");
  assert.equal(clearPayload(request).aps.category, "NEW_MAIL");
  assert.equal(clearPayload(request).ksmail.uid, 11);
  assert.equal(clearPayload(request).ksmail.mailbox, "INBOX");
  assert.equal(clearPayload(request).ksmail.account.address, "moi@kikisoft.fr");
  assert.equal(clearPayload(request).ksmail.from.address, "jean@exemple.fr");
  // What travels is the PREVIEW, never the bytes it was cut from: no part header, no encoding, no boundary.
  assert.equal(JSON.stringify(clearPayload(request)).includes("Content-Type"), false);

  await stop();
});

/// The privacy claim of this component is that below "full" the code which reads a body is never reached, and that is only true if the FETCH itself does not ask for one. So the FETCH is what is checked, on the server side, rather than the payload.
test("below the full preview level, no body is ever asked of the server", async () => {
  const imap = new FakeImapServer({
    messages: [{ uid: 10, flags: [], internalDate: nowInternalDate(2), subject: "Ancien", from: { name: "Vieux", address: "vieux@exemple.fr" } }],
  });
  const { monitor, broker, stop } = await harness(imap, { preview: "subject" });
  monitor.run();
  await waitFor(() => monitor.status.connected, { what: "the monitor to be watching" });

  imap.deliver({
    uid: 11,
    flags: [],
    internalDate: nowInternalDate(0),
    subject: "Réunion de lundi",
    from: { name: "Jean Dupont", address: "jean@exemple.fr" },
    body: "Ceci ne doit jamais quitter le Pi.",
  });
  await waitFor(() => broker.notifications.length === 1, { what: "the push" });

  assert.equal(
    imap.commandLog.some((line) => line.toUpperCase().includes("BODY")),
    false,
    "no FETCH may mention a body at this level",
  );
  const alert = clearPayload(broker.notifications[0]).aps.alert;
  assert.equal(alert.title, "Jean Dupont");
  assert.equal(alert.subtitle, "Réunion de lundi");
  assert.equal(alert.body, undefined);

  await stop();
});

/// The Journal du Geek shape (snippet.test.js): a text part longer than the first slice, then an html part whose <body> is past it. One slice announced the text part's courtesy line and two URLs where Gmail showed the headline. The second read is what makes the push say the headline, it is the NEXT slice of the same body, and it is issued for this message only: the ordinary one that follows is announced on its first slice, without a second command.
test("a newsletter whose text part fills the first slice is read further, and says its headline", async () => {
  const imap = new FakeImapServer({
    messages: [{ uid: 10, flags: [], internalDate: nowInternalDate(2), subject: "Ancien", from: { name: "Vieux", address: "vieux@exemple.fr" } }],
  });
  const { monitor, broker, stop } = await harness(imap);
  monitor.run();
  await waitFor(() => monitor.status.connected, { what: "the monitor to be watching" });

  const crlf = (text) => text.replace(/\n/g, "\r\n");
  const articles = "Lire l'article -> https://exemple.fr/track/click?u=5d1996e209836e7d96d01e9a4&id=4f26e8d072\n".repeat(230);
  const stylesheet = "  .mcnTextContent { padding: 0 18px; line-height: 150%; }\n".repeat(220);
  const newsletter = crlf(
    "--alt\n" +
      "Content-Type: text/plain; charset=utf-8\n\n" +
      "Voir cet email dans votre navigateur (https://exemple.fr/archive?e=22e63494aa)\n" +
      `${articles}` +
      "--alt\n" +
      "Content-Type: text/html; charset=utf-8\n\n" +
      `<html><head><style>\n${stylesheet}</style></head><body>` +
      "<h1>Oubliez l'iPhone Duo, Apple pourrait creer l'iPhone Duo Max</h1></body></html>\n" +
      "--alt--\n",
  );
  const bodyAt = Buffer.from(newsletter, "utf8").indexOf("<body>");
  assert.ok(bodyAt > PREFIX_BYTES && newsletter.length < DEEP_PREFIX_BYTES, `${bodyAt} ${newsletter.length}`);

  imap.deliver({
    uid: 11,
    flags: [],
    internalDate: nowInternalDate(0),
    subject: "Oubliez l'iPhone Duo",
    from: { name: "Le Journal du Geek", address: "contact@exemple.fr" },
    body: newsletter,
  });
  await waitFor(() => broker.notifications.length === 1, { what: "the push" });
  assert.equal(
    clearPayload(broker.notifications[0]).aps.alert.body,
    "Oubliez l'iPhone Duo, Apple pourrait creer l'iPhone Duo Max",
  );
  const reads = () => imap.commandLog.filter((line) => /BODY\.PEEK/i.test(line));
  assert.equal(reads().length, 2, reads().join("\n"));
  assert.match(reads()[0], new RegExp(`^\\S+ UID FETCH 11 \\(UID BODY\\.PEEK\\[TEXT\\]<0\\.${PREFIX_BYTES}>\\)$`));
  assert.match(reads()[1], new RegExp(`^\\S+ UID FETCH 11 \\(UID BODY\\.PEEK\\[TEXT\\]<${PREFIX_BYTES}\\.${DEEP_PREFIX_BYTES - PREFIX_BYTES}>\\)$`));

  imap.deliver({
    uid: 12,
    flags: [],
    internalDate: nowInternalDate(0),
    subject: "Réunion de lundi",
    from: { name: "Jean Dupont", address: "jean@exemple.fr" },
    body: "Bonjour,\r\nla réunion est décalée à 10h.\r\n",
  });
  await waitFor(() => broker.notifications.length === 2, { what: "the second push" });
  assert.equal(clearPayload(broker.notifications[1]).aps.alert.body, "Bonjour, la réunion est décalée à 10h.");
  assert.equal(reads().length, 3, reads().join("\n"));
  assert.match(reads()[2], /^\S+ UID FETCH 12 \(UID BODY\.PEEK\[TEXT\]<0\.\d+>\)$/);

  await stop();
});

/// One watcher for a household: an account is pushed to the devices it names in the configuration and to no others, whoever else the broker knows.
test("an account is pushed to its own devices, one request each, and to no other", async () => {
  const imap = new FakeImapServer({
    messages: [{ uid: 10, flags: [], internalDate: nowInternalDate(2), subject: "Ancien", from: { name: "Vieux", address: "vieux@exemple.fr" } }],
  });
  const { monitor, broker, stop } = await harness(imap, { devices: [IPHONE, MAC] });
  monitor.run();
  await waitFor(() => monitor.status.connected, { what: "the monitor to be watching" });

  imap.deliver({
    uid: 11,
    flags: [],
    internalDate: nowInternalDate(0),
    subject: "Réunion de lundi",
    from: { name: "Jean Dupont", address: "jean@exemple.fr" },
  });
  await waitFor(() => broker.notifications.length === 2, { what: "the two pushes" });
  assert.deepEqual(
    broker.notifications.map((request) => request.body.installationSecret).sort(),
    [IPHONE.installationSecret, MAC.installationSecret].sort(),
  );
  assert.deepEqual(clearPayload(broker.notifications[0]), clearPayload(broker.notifications[1]));

  await stop();
});

/// A device the broker does not know (401) or that Apple dropped (410) is the device's problem, not the mailbox's: the mark moves, the other device still gets its banner, and the watcher carries on.
test("a device the broker refuses does not hold up the mailbox or the other device", async () => {
  const imap = new FakeImapServer({
    messages: [{ uid: 10, flags: [], internalDate: nowInternalDate(2), subject: "Ancien", from: { name: "Vieux", address: "vieux@exemple.fr" } }],
  });
  const { monitor, broker, state, stop } = await harness(imap, { devices: [IPHONE, MAC] });
  broker.answers = [
    { status: 401, body: { error: "no device is registered under this installation secret" } },
    { status: 200, body: { ok: true } },
  ];
  monitor.run();
  await waitFor(() => monitor.status.connected, { what: "the monitor to be watching" });

  imap.deliver({
    uid: 11,
    flags: [],
    internalDate: nowInternalDate(0),
    subject: "Réunion de lundi",
    from: { name: "Jean Dupont", address: "jean@exemple.fr" },
  });
  await waitFor(() => state.mailboxState("perso", "INBOX")?.lastUid === 11, { what: "the mark to move" });
  await waitFor(() => broker.notifications.length === 2, { what: "both requests" });
  assert.equal(monitor.running, true);

  await stop();
});

test("the mark moves forward so the same message is never pushed twice", async () => {
  const imap = new FakeImapServer({ messages: [{ uid: 5, flags: [], internalDate: nowInternalDate(1), subject: "Un", from: { name: "A", address: "a@b.fr" } }] });
  const { monitor, state, broker, stop } = await harness(imap);
  monitor.run();
  await waitFor(() => monitor.status.connected);

  imap.deliver({ uid: 6, flags: [], internalDate: nowInternalDate(0), subject: "Deux", from: { name: "B", address: "b@b.fr" } });
  await waitFor(() => broker.notifications.length === 1, { what: "the first push" });
  assert.equal(state.mailboxState("perso", "INBOX").lastUid, 6);

  // A second IDLE wake with nothing new behind it (a flag changed on another client) must not push anything again.
  imap.deliver({ uid: 7, flags: ["\\Seen"], internalDate: nowInternalDate(0), subject: "Lu ailleurs", from: { name: "C", address: "c@b.fr" } });
  await waitFor(() => state.mailboxState("perso", "INBOX").lastUid === 7, { what: "the mark to move" });
  assert.equal(broker.notifications.length, 1, "a message already read elsewhere is not news");

  await stop();
});

test("what arrived while the watcher was down is pushed when it comes back", async () => {
  const imap = new FakeImapServer({
    messages: [
      { uid: 20, flags: [], internalDate: nowInternalDate(3), subject: "Pendant la panne", from: { name: "Jean", address: "jean@exemple.fr" } },
      { uid: 21, flags: [], internalDate: nowInternalDate(2), subject: "Aussi", from: { name: "Marie", address: "marie@exemple.fr" } },
    ],
  });
  const { monitor, broker, stop } = await harness(imap, {
    stateSeed: { "perso INBOX": { uidValidity: 42, lastUid: 19, updatedAt: new Date().toISOString() } },
  });
  monitor.run();

  await waitFor(() => broker.notifications.length === 2, { what: "both messages" });
  assert.deepEqual(
    broker.notifications.map((request) => clearPayload(request).ksmail.uid),
    [20, 21],
  );

  await stop();
});

test("a mailbox the server renumbered starts over instead of replaying it", async () => {
  const imap = new FakeImapServer({
    uidValidity: 99,
    messages: [
      { uid: 1, flags: [], internalDate: nowInternalDate(1), subject: "Un", from: { name: "A", address: "a@b.fr" } },
      { uid: 2, flags: [], internalDate: nowInternalDate(1), subject: "Deux", from: { name: "B", address: "b@b.fr" } },
    ],
  });
  const { monitor, state, broker, stop } = await harness(imap, {
    stateSeed: { "perso INBOX": { uidValidity: 42, lastUid: 500, updatedAt: new Date().toISOString() } },
  });
  monitor.run();

  await waitFor(() => state.mailboxState("perso", "INBOX").uidValidity === 99, { what: "the new uidvalidity" });
  assert.equal(state.mailboxState("perso", "INBOX").lastUid, 2);
  assert.equal(broker.notifications.length, 0, "renumbering is not two hundred notifications");

  await stop();
});

/// The failure that went unnoticed for a week: an account the watcher cannot sign in to any more. The mailbox is given up (retrying a bad password is how an account gets locked), but the owner has to hear about it on the devices that were waiting for that mail, and the process has to keep serving the other accounts.
test("a refused password gives the mailbox up and tells the account's devices, once", async () => {
  const imap = new FakeImapServer({ password: "changed" });
  const { monitor, monitorFor, broker, stop } = await harness(imap);
  const second = monitorFor("Archive");
  monitor.run();
  await waitFor(() => monitor.status.givenUp === "loginRefused", { what: "the mailbox to give up" });
  assert.equal(monitor.running, true, "given up is not stopped: the process must not drain");

  await waitFor(() => broker.notifications.length === 1, { what: "the alert" });
  const request = broker.notifications[0];
  assert.equal(request.body.collapseId, sealedCollapseId(IPHONE.encryptionKey, "perso.watcher-alert"));
  // Still worth showing the next day, unlike a mail alert.
  assert.equal(request.body.expiresIn, 24 * 3600);
  assert.equal(clearPayload(request).ksmail.kind, "watcherAlert");
  assert.equal(clearPayload(request).ksmail.reason, "loginRefused");
  assert.equal(clearPayload(request).ksmail.account.address, "moi@kikisoft.fr");
  // The phone translates: the text travels as a key, and the key is the English sentence so an app without it still shows something.
  assert.equal(clearPayload(request).aps.alert["title-loc-key"], "Push notifications stopped");
  assert.equal(clearPayload(request).aps.alert.subtitle, "Perso");
  assert.match(clearPayload(request).aps.alert["loc-key"], /refused its password/);
  assert.equal(clearPayload(request).aps.alert.body, undefined);
  // No mail buttons on an alert that names no mail, and no wake-up of the app for a message that does not exist.
  assert.equal(clearPayload(request).aps.category, undefined);
  assert.equal(clearPayload(request).aps["content-available"], undefined);

  // A second watched folder of the same account fails the same way and must not stack a second alert.
  second.run();
  await waitFor(() => second.status.givenUp === "loginRefused", { what: "the second mailbox to give up" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(broker.notifications.length, 1, "one alert per account");

  second.stop();
  await stop();
});

test("a dead refresh token gives the mailbox up and tells the account's devices", async () => {
  const imap = new FakeImapServer({ accessToken: "never-minted" });
  const deadAuth = {
    token: async () => {
      throw new OAuthError("invalid_grant: Token has been expired or revoked.", { permanent: true });
    },
  };
  const { monitor, broker, stop } = await harness(imap, {
    account: { ...ACCOUNT, auth: { type: "oauth", provider: "google", clientId: "c", refreshToken: "r" } },
    auth: deadAuth,
  });
  monitor.run();
  await waitFor(() => monitor.status.givenUp === "oauthExpired", { what: "the mailbox to give up" });
  await waitFor(() => broker.notifications.length === 1, { what: "the alert" });
  assert.equal(clearPayload(broker.notifications[0]).ksmail.reason, "oauthExpired");
  assert.match(clearPayload(broker.notifications[0]).aps.alert["loc-key"], /authorization has expired/);

  await stop();
});

test("a burst bigger than the cap only wakes the phone for the last messages", () => {
  const monitor = new MailboxMonitor({
    account: ACCOUNT, mailbox: "INBOX", auth: null,
    config: { ...WATCH_CONFIG, maxCatchUpPerMailbox: 2 },
    state: new State("/dev/null", quietLog), log: quietLog, notifier: null,
  });
  const arrived = [1, 2, 3, 4, 5].map((uid) => ({
    uid, flags: [], internalDate: nowInternalDate(0), envelope: {},
  }));
  assert.deepEqual(monitor.selectWorthPushing(arrived).map((item) => item.uid), [4, 5]);
});

/// The memory rule (docs/DESIGN.md, "Memory"). A preview costs 32 KB of body; the fetch that finds what arrived answers for EVERY message above the mark. Asking for the bodies in that one made a week of downtime cost one slice per waiting message to push five of them, and 2000 of them were 324 MB on a Pi that has 1 GB. So: the fetch that finds what arrived carries NO body, and the bodies are asked for afterwards, by UID, for the messages that are pushed and for no others.
test("a burst is read for its headers, and only the pushed messages cost a body", async () => {
  const imap = new FakeImapServer({
    messages: [{ uid: 10, flags: [], internalDate: nowInternalDate(2), subject: "Ancien", from: { name: "Vieux", address: "vieux@exemple.fr" } }],
  });
  const { monitor, broker, stop } = await harness(imap, {
    stateSeed: { "perso INBOX": { uidValidity: 42, lastUid: 10 } },
  });
  // Twenty messages waiting, five of which may be pushed.
  for (let uid = 11; uid <= 30; uid += 1) {
    imap.messages.push({
      uid, flags: [], internalDate: nowInternalDate(0),
      subject: `Sujet ${uid}`, from: { name: "Jean Dupont", address: "jean@exemple.fr" },
      body: "Bonjour,\r\nle corps de ce message ne doit jamais etre lu.\r\n",
    });
  }
  monitor.run();
  await waitFor(() => broker.notifications.length === 5, { what: "the five pushes" });

  const envelopeFetch = imap.commandLog.find((line) => /UID FETCH 11:\*/i.test(line));
  assert.match(envelopeFetch, /^\S+ UID FETCH 11:\* \(UID FLAGS INTERNALDATE ENVELOPE\)$/);
  assert.equal(
    /BODY/i.test(envelopeFetch),
    false,
    "the fetch that finds what arrived must never carry a body, whatever is waiting",
  );

  const previewFetches = imap.commandLog.filter((line) => /BODY\.PEEK/i.test(line));
  assert.equal(previewFetches.length, 1, previewFetches.join("\n"));
  assert.match(
    previewFetches[0],
    new RegExp(`^\\S+ UID FETCH 26,27,28,29,30 \\(UID BODY\\.PEEK\\[TEXT\\]<0\\.${PREFIX_BYTES}>\\)$`),
  );
  assert.equal(clearPayload(broker.notifications[0]).aps.alert.body, "Bonjour, le corps de ce message ne doit jamais etre lu.");

  await stop();
});

test("mail filed into the mailbox from another client is not announced as received", () => {
  const monitor = new MailboxMonitor({
    account: ACCOUNT, mailbox: "INBOX", auth: null,
    config: WATCH_CONFIG,
    state: new State("/dev/null", quietLog), log: quietLog, notifier: null,
  });
  const arrived = [
    { uid: 1, flags: [], internalDate: nowInternalDate(0), envelope: {} },
    { uid: 2, flags: [], internalDate: nowInternalDate(48), envelope: {} },
    { uid: 3, flags: ["\\Seen"], internalDate: nowInternalDate(0), envelope: {} },
    { uid: 4, flags: ["\\Deleted"], internalDate: nowInternalDate(0), envelope: {} },
  ];
  assert.deepEqual(monitor.selectWorthPushing(arrived).map((item) => item.uid), [1]);
});
