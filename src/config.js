//
//  config.js
//  ksmail-watcher
//
//  Loads and VALIDATES the configuration file. Validation is strict and happens once at startup, because the alternative is a watcher that starts, looks healthy for three weeks and has never been able to deliver a push: every field the process needs is checked here, up front, with a message naming the field.
//
//  The file holds mail passwords and OAuth refresh tokens, so it is read from disk and never echoed back anywhere. It holds nothing of Apple's: no key, no team, no bundle identifier. Those live in the ksMail broker, which this watcher reaches by URL with, per device, an installation secret and the key that seals what it is sent.
//

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DEFAULT_BROKER_URL, normalizeInstallationSecret } from "./push/broker.js";
import { parseEncryptionKey } from "./push/seal.js";

export const DEFAULT_CONFIG_PATH = "/etc/ksmail-watcher/config.json";

class ConfigError extends Error {}

function fail(message) {
  throw new ConfigError(`configuration: ${message}`);
}

function requireString(object, path, name) {
  const value = object?.[name];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${path}.${name} is required and must be a non empty string`);
  }
  return value.trim();
}

function optionalString(object, name, fallback = null) {
  const value = object?.[name];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") {
    fail(`${name} must be a string`);
  }
  return value;
}

function optionalNumber(object, name, fallback) {
  const value = object?.[name];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${name} must be a number`);
  }
  return value;
}

function optionalBoolean(object, name, fallback) {
  const value = object?.[name];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    fail(`${name} must be a boolean`);
  }
  return value;
}

function oneOf(value, allowed, path) {
  if (!allowed.includes(value)) {
    fail(`${path} must be one of ${allowed.join(", ")} (got ${value})`);
  }
  return value;
}

/// Paths in the file are resolved against the file's own directory, so a configuration and its state can travel together in one folder.
function resolvePath(value, baseDirectory) {
  return isAbsolute(value) ? value : resolve(baseDirectory, value);
}

function parseAccount(raw, index, baseDirectory) {
  const path = `accounts[${index}]`;
  const id = requireString(raw, path, "id");
  const address = requireString(raw, path, "address").toLowerCase();
  const host = requireString(raw, path, "host");
  const auth = raw.auth;
  if (!auth || typeof auth !== "object") {
    fail(`${path}.auth is required`);
  }
  const type = oneOf(requireString(auth, `${path}.auth`, "type"), ["password", "oauth"], `${path}.auth.type`);

  let credentials;
  if (type === "password") {
    const password = requireString(auth, `${path}.auth`, "password");
    // Google shows an app password as four groups of four letters, and a copy takes the spaces along: the password is the sixteen letters.
    // Gmail only, as in the app: any other password may hold a space on purpose, and must go as it was written.
    const gmail = /^imap\.(gmail|googlemail)\.com$/i.test(host);
    credentials = { type, password: gmail ? password.replace(/\s+/g, "") : password };
  } else {
    credentials = {
      type,
      provider: oneOf(
        requireString(auth, `${path}.auth`, "provider"),
        ["google", "microsoft"],
        `${path}.auth.provider`,
      ),
      clientId: requireString(auth, `${path}.auth`, "clientId"),
      clientSecret: optionalString(auth, "clientSecret"),
      // Optional here because "ksmail-watcher oauth --account" puts the token in the state file, not in this read only file. An account with a token in neither place is refused at startup (run.js), where the state file is at hand.
      refreshToken: optionalString(auth, "refreshToken", null),
      tenant: optionalString(auth, "tenant", "common"),
    };
  }

  const mailboxes = raw.mailboxes ?? ["INBOX"];
  if (!Array.isArray(mailboxes) || mailboxes.length === 0 ||
      mailboxes.some((name) => typeof name !== "string" || name === "")) {
    fail(`${path}.mailboxes must be a non empty array of mailbox names`);
  }

  return {
    id,
    // What the push carries to name the account, and what the app matches on. See docs/PROTOCOL.md.
    address,
    displayName: optionalString(raw, "displayName", id),
    host,
    port: optionalNumber(raw, "port", 993),
    tls: optionalBoolean(raw, "tls", true),
    // Login name, which is the address on every provider ksMail targets but stays separate because some hosters do not agree.
    username: optionalString(raw, "username", address),
    auth: credentials,
    mailboxes,
    enabled: optionalBoolean(raw, "enabled", true),
    // The names, in broker.devices, of the devices this account is pushed to; absent means every device. Resolved to the devices themselves once both halves are read (parseConfig). It is what lets one watcher serve a household: each person's mail goes to that person's devices and no one else's.
    devices: parseDeviceNames(raw.devices, `${path}.devices`),
    baseDirectory,
  };
}

function parseDeviceNames(raw, path) {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (!Array.isArray(raw) || raw.some((name) => typeof name !== "string" || name === "")) {
    fail(`${path} must be a list of device names from broker.devices`);
  }
  if (raw.length === 0) {
    fail(
      `${path} is empty, which pushes this account to nobody: remove the field to push ` +
        "it to every device, or set enabled to false",
    );
  }
  return raw;
}

/// Where the pushes go: the broker, and the devices it knows.
///
///   "broker": {
///     "url": "https://ksmail-broker.kikisoft.com",
///     "devices": {
///       "iPhone": {
///         "installationSecret": "Q1PXY-R6HAV-ANVEE-83269-J4ZZ2",
///         "encryptionKey": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
///       }
///     }
///   }
///
/// The url may be left out: it is then the broker of the App Store ksMail (DEFAULT_BROKER_URL).
/// Both values are what ksMail shows under Settings > Push Notifications on that device, and "ksmail-watcher add-device" writes the whole entry from the line ksMail shares. The name is this file's own, for the log and for accounts[].devices; the broker never sees it, nor the key.
function parseBroker(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(
      "broker is required: { \"devices\": { \"<a name>\": { \"installationSecret\": ..., " +
        "\"encryptionKey\": ... } } }, which ksmail-watcher add-device writes from the line ksMail shares",
    );
  }
  // Absent means the broker of the App Store ksMail, which is the one nearly everyone has.
  const url = raw.url === undefined ? DEFAULT_BROKER_URL : requireString(raw, "broker", "url");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(`broker.url is not a URL (${url})`);
  }
  // Plain HTTP only to this machine, which is the tests and a broker run with "wrangler dev". Anything else carries the secrets in clear.
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    fail("broker.url must be an https:// address");
  }

  const entries = raw.devices;
  if (!entries || typeof entries !== "object" || Array.isArray(entries) || Object.keys(entries).length === 0) {
    fail(
      "broker.devices must name at least one device: { \"iPhone\": { \"installationSecret\": " +
        "..., \"encryptionKey\": ... } }, as ksMail copies it under Settings > Push Notifications",
    );
  }
  const devices = [];
  const nameBySecret = new Map();
  for (const [name, value] of Object.entries(entries)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(
        `broker.devices.${name} must be { "installationSecret": ..., "encryptionKey": ... }: ` +
          "every notification is sealed for its device, and the key is what ksMail shows " +
          "under Settings > Push Notifications, next to the secret",
      );
    }
    const installationSecret = normalizeInstallationSecret(value.installationSecret);
    if (!installationSecret) {
      fail(
        `broker.devices.${name}.installationSecret is not an installation secret: 25 letters ` +
          "and digits, as ksMail shows it under Settings > Push Notifications",
      );
    }
    const encryptionKey = parseEncryptionKey(value.encryptionKey);
    if (!encryptionKey) {
      fail(
        `broker.devices.${name}.encryptionKey is not an encryption key: 43 characters, ` +
          "as ksMail shows it under Settings > Push Notifications",
      );
    }
    if (nameBySecret.has(installationSecret)) {
      fail(
        `broker.devices.${name} and broker.devices.${nameBySecret.get(installationSecret)} ` +
          "hold the same secret, which would push everything twice to one device",
      );
    }
    nameBySecret.set(installationSecret, name);
    devices.push({ name, installationSecret, encryptionKey });
  }
  return { url: url.replace(/\/+$/, ""), devices };
}

function parseNotifications(raw) {
  const section = raw ?? {};
  return {
    // Seconds Apple keeps trying to deliver an undelivered push. A mail alert that shows up six hours late is noise, not information. The broker caps it at a day.
    expirationSeconds: optionalNumber(section, "expirationSeconds", 3600),
    sound: optionalString(section, "sound", "default"),
    // What the lock screen is allowed to say before the phone is unlocked, and by the same token what leaves the Pi:
    //   "full"       sender, subject, and a line of the message
    //   "subject"    sender and subject
    //   "senderOnly" sender alone, the rest waits for the app to open
    // Only "full" makes the watcher fetch a body prefix at all; below that, the code that reads a body is never reached (docs/PROTOCOL.md).
    preview: oneOf(
      optionalString(section, "preview", "full"),
      ["full", "subject", "senderOnly"],
      "notifications.preview",
    ),
  };
}

/// The two sections of the watcher that talked to Apple itself. Left in a file, they are refused with the way out rather than ignored: one of them points at the Apple key, which has no business on this machine any more.
function refuseRetiredSections(raw) {
  if (raw.apns !== undefined) {
    fail(
      "the apns section is gone: the watcher no longer talks to Apple, the ksMail broker " +
        "does. Move preview, expirationSeconds and sound to a \"notifications\" section, " +
        "delete the rest, and delete the key file from this machine",
    );
  }
  if (raw.devices !== undefined) {
    fail(
      "the devices section is gone: the devices are now listed in broker.devices, each by " +
        "the installation secret ksMail shows under Settings > Push Notifications. Delete " +
        "the section, and the CloudKit key file with it",
    );
  }
}

export function parseConfig(raw, { baseDirectory = process.cwd() } = {}) {
  if (!raw || typeof raw !== "object") {
    fail("the file must contain a JSON object");
  }
  refuseRetiredSections(raw);
  if (!Array.isArray(raw.accounts) || raw.accounts.length === 0) {
    fail("accounts must be a non empty array");
  }
  const accounts = raw.accounts.map((account, index) => parseAccount(account, index, baseDirectory));
  const seen = new Set();
  for (const account of accounts) {
    if (seen.has(account.id)) {
      fail(`two accounts share the id ${account.id}`);
    }
    seen.add(account.id);
  }

  const broker = parseBroker(raw.broker);
  // Each account ends up with the devices it is pushed to: the ones it names, or all of them. Checked here and not in either half, because a name is a question about the pair of them.
  const deviceByName = new Map(broker.devices.map((device) => [device.name, device]));
  for (const account of accounts) {
    if (account.devices === null) {
      account.devices = broker.devices;
      continue;
    }
    account.devices = account.devices.map((name) => {
      const device = deviceByName.get(name);
      if (!device) {
        fail(`${account.id} names the device "${name}", which broker.devices does not list`);
      }
      return device;
    });
  }

  return {
    accounts,
    broker,
    notifications: parseNotifications(raw.notifications),
    // Where the highest UID already pushed per mailbox is remembered, so a restart neither replays yesterday's mail nor swallows what arrived while the process was down.
    stateFile: resolvePath(optionalString(raw, "stateFile", "state/state.json"), baseDirectory),
    logLevel: oneOf(optionalString(raw, "logLevel", "info"), ["error", "warn", "info", "debug"], "logLevel"),
    // How many messages one reconnection is allowed to push at once. A week of downtime must not empty a hundred notifications onto the lock screen.
    maxCatchUpPerMailbox: optionalNumber(raw, "maxCatchUpPerMailbox", 5),
    // Older than this at reconnection and the message is counted, never pushed: it is not news any more.
    catchUpMaxAgeHours: optionalNumber(raw, "catchUpMaxAgeHours", 12),
    // Seconds between two passes on a server that does not advertise IDLE. Every account ksMail targets does, so this is the safety net and not the normal path.
    pollSeconds: optionalNumber(raw, "pollSeconds", 120),
  };
}

export function loadConfig(path = DEFAULT_CONFIG_PATH) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ConfigError(`configuration file not found: ${path}`);
    }
    throw error;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${error.message}`);
  }
  const config = parseConfig(raw, { baseDirectory: dirname(resolve(path)) });
  warnAboutPermissions(path);
  return config;
}

/// The file carries passwords in clear. Say so once, loudly, when the filesystem lets anyone else read it.
function warnAboutPermissions(path) {
  try {
    const mode = statSync(path).mode & 0o077;
    if (mode !== 0) {
      process.stderr.write(
        `WARNING ${path} is readable by other users (chmod 600 it: it holds mail passwords ` +
          "and the installation secrets of your devices)\n",
      );
    }
  } catch {
    // Not being able to stat the file we just read is not worth failing on.
  }
}

export { ConfigError };
