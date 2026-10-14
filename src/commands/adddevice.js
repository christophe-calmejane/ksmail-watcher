//
//  adddevice.js
//  ksmail-watcher
//
//  "ksmail-watcher add-device <code>": puts a device in the configuration from the line ksMail shared, instead of having anyone type a 25 character secret and a 43 character key into a JSON file.
//
//  It also fills the broker's address the first time (the device's own, should the configuration still hold the default one), removes the placeholders of the example configuration, updates a device it already has (same secret, a new key), and then asks the broker whether it knows the device, so the answer comes now and not at the first mail. Without a code on the command line it asks for one, and the whole message ksMail sent can be pasted: the code is found in it.
//
//  The file is rewritten as JSON with two spaces of indentation: its values are kept, its blank lines are not.
//

import { accessSync, constants, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import readline from "node:readline/promises";
import { parseDeviceCode, DeviceCodeError } from "../push/devicecode.js";
import { BrokerClient, DEFAULT_BROKER_URL, normalizeInstallationSecret } from "../push/broker.js";

export class AddDeviceError extends Error {
  constructor(message, { conflict = null } = {}) {
    super(message);
    this.conflict = conflict;
  }
}

function isPlaceholder(value) {
  return JSON.stringify(value ?? "").includes("PASTE");
}

function formatted(secret) {
  return (secret.match(/.{1,5}/g) ?? []).join("-");
}

function sameBroker(left, right) {
  return left.trim().replace(/\/+$/, "").toLowerCase() === right.trim().replace(/\/+$/, "").toLowerCase();
}

/// The configuration with this device in it, and what was done. Pure, so the rules can be tested without a file.
///
///   added     a new name
///   updated   the same secret was already there (under whatever name): its key and its name are kept up to date
///   replaced  the name was taken by another device, and `replace` said to take it over (ksMail reinstalled on that phone)
export function applyDevice(raw, device, { name = null, replace = false } = {}) {
  const config = structuredClone(raw ?? {});
  const notes = [];
  config.broker = config.broker && typeof config.broker === "object" ? config.broker : {};

  const devices = config.broker.devices && typeof config.broker.devices === "object" &&
    !Array.isArray(config.broker.devices) ? config.broker.devices : {};
  for (const [entryName, entry] of Object.entries(devices)) {
    if (isPlaceholder(entry)) {
      delete devices[entryName];
    }
  }
  config.broker.devices = devices;

  // The url is written down, even when it is the default, so that the file says where the notifications go.
  // The default is not a choice anybody made: until a first device is in, that device's broker wins (a build of ksMail with a broker of its own).
  const current = typeof config.broker.url === "string" && !isPlaceholder(config.broker.url) && config.broker.url.trim() !== ""
    ? config.broker.url
    : null;
  const defaultOnly = current !== null && sameBroker(current, DEFAULT_BROKER_URL) && Object.keys(devices).length === 0;
  if (current === null || (defaultOnly && !sameBroker(current, device.broker))) {
    config.broker.url = device.broker;
    notes.push(`broker.url set to ${device.broker}`);
  } else if (!sameBroker(current, device.broker)) {
    throw new AddDeviceError(
      `this device is registered with ${device.broker}, but this watcher sends to ` +
        `${current}: one watcher talks to one broker. Check broker.url`,
    );
  }

  const entry = { installationSecret: formatted(device.installationSecret), encryptionKey: device.encryptionKey };
  const known = Object.entries(devices).find(([, value]) => {
    const secret = typeof value === "string" ? value : value?.installationSecret;
    return normalizeInstallationSecret(secret) === device.installationSecret;
  });
  if (known) {
    devices[known[0]] = entry;
    return { config, action: "updated", name: known[0], notes };
  }

  const target = name ?? device.name;
  if (devices[target] && !replace) {
    throw new AddDeviceError(`a device named "${target}" is already in the configuration`, { conflict: target });
  }
  const action = devices[target] ? "replaced" : "added";
  devices[target] = entry;

  if (action === "added") {
    const listing = (Array.isArray(config.accounts) ? config.accounts : [])
      .filter((account) => Array.isArray(account?.devices))
      .map((account) => account.id);
    if (listing.length > 0) {
      notes.push(
        `${listing.join(", ")} list their own devices: add "${target}" to the accounts ` +
          "that should ring on it (the others reach every device already)",
      );
    }
  }
  return { config, action, name: target, notes };
}

/// A name nobody uses yet: "iPhone 2", "iPhone 3"...
export function freeName(config, wanted) {
  const devices = config?.broker?.devices ?? {};
  let index = 2;
  while (devices[`${wanted} ${index}`]) {
    index += 1;
  }
  return `${wanted} ${index}`;
}

function writeAtomically(path, text) {
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    // A new file: private.
  }
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, path);
}

/// Why the configuration cannot be written, as a sentence that says what to do, or null when it can.
/// Asked before the code, so nobody pastes a line for nothing.
export function whyNotWritable(configPath, { docker = process.env.KSMAIL_WATCHER_DOCKER === "1" } = {}) {
  try {
    accessSync(dirname(configPath), constants.W_OK);
    accessSync(configPath, constants.R_OK | constants.W_OK);
    return null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    if (error.code === "EROFS") {
      return `${configPath} is mounted read only, which is how the service mounts it. ` +
        (docker
          ? "Install the ksmail-watcher command (sudo ./scripts/install-docker-command.sh) and run add-device through it, or mount the folder writable: " +
            "docker compose run --rm -v \"$PWD/config:/edit\" ksmail-watcher add-device --config /edit/config.json"
          : "Run add-device on a writable copy, with --config.");
    }
    if (error.code === "EACCES" || error.code === "EPERM") {
      return `${configPath} cannot be written by this user. ` +
        (docker
          ? "The container runs as uid 1000: on the host, sudo chown -R 1000:1000 config state"
          : "Run it through the ksmail-watcher command, which runs as the service user.");
    }
    return `${configPath}: ${error.message}`;
  }
}

export async function addDevice({
  configPath, code = null, name = null, replace = false,
  input = process.stdin, output = process.stdout,
  brokerFor = (url) => new BrokerClient({ url }),
}) {
  const say = (text = "") => output.write(`${text}\n`);
  const interactive = Boolean(input.isTTY);
  const ask = async (question) => {
    const prompt = readline.createInterface({ input, output, terminal: interactive });
    try {
      return await prompt.question(question);
    } finally {
      prompt.close();
    }
  };

  const unwritable = whyNotWritable(configPath);
  if (unwritable) {
    say(`FAIL  ${unwritable}`);
    return 1;
  }

  let text = code;
  if (!text) {
    say("Paste the line ksMail shared (Settings > Push Notifications > Send to the Watcher),");
    say("or the whole message it is in, then press Enter:");
    text = await ask("> ");
  }

  let device;
  try {
    device = parseDeviceCode(text);
  } catch (error) {
    if (error instanceof DeviceCodeError) {
      say(`FAIL  ${error.message}`);
      return 1;
    }
    throw error;
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    say(error.code === "ENOENT"
      ? `FAIL  no configuration at ${configPath}: create it from config.example.json first (the installer does)`
      : `FAIL  ${configPath} is not valid JSON: ${error.message}`);
    return 1;
  }

  let result;
  try {
    result = applyDevice(raw, device, { name, replace });
  } catch (error) {
    if (!(error instanceof AddDeviceError) || !error.conflict) {
      if (error instanceof AddDeviceError) {
        say(`FAIL  ${error.message}`);
        return 1;
      }
      throw error;
    }
    // The same name, another device: a phone with ksMail reinstalled (its old secret is dead), or a second phone of the same model.
    const other = freeName(raw, error.conflict);
    if (!interactive) {
      say(`FAIL  ${error.message}. Run it again with --replace to take its place ` +
        `(ksMail reinstalled on it), or with --name "${other}" to keep both.`);
      return 1;
    }
    const answer = (await ask(
      `A device named "${error.conflict}" is already configured. Replace it (ksMail was ` +
        `reinstalled on it) [r], keep both and call this one "${other}" [k], or cancel [c]? `,
    )).trim().toLowerCase();
    if (answer.startsWith("r")) {
      result = applyDevice(raw, device, { name: error.conflict, replace: true });
    } else if (answer.startsWith("k")) {
      result = applyDevice(raw, device, { name: other });
    } else {
      say("Nothing changed.");
      return 1;
    }
  }

  writeAtomically(configPath, `${JSON.stringify(result.config, null, 2)}\n`);
  const done = {
    added: `Added "${result.name}" to`,
    updated: `Updated "${result.name}" in`,
    replaced: `Replaced "${result.name}" in`,
  }[result.action];
  say(`${done} ${configPath}.`);
  for (const note of result.notes) {
    say(`  note  ${note}`);
  }

  const broker = brokerFor(result.config.broker.url);
  const check = await broker.notify({ installationSecret: device.installationSecret, dryRun: true });
  if (check.ok) {
    say(`  ok    the broker knows this device (${check.answer.environment})`);
  } else if (check.status === 401) {
    say("  FAIL  the broker does not know this device: is Receive Notifications from a Watcher still on in ksMail?");
  } else {
    say(`  FAIL  could not ask the broker: ${check.status} ${check.reason ?? ""}`.trimEnd());
  }
  say("Restart the watcher for it to take effect:");
  say(process.env.KSMAIL_WATCHER_DOCKER === "1"
    ? "  docker compose restart      (in the watcher's folder)"
    : "  sudo systemctl restart ksmail-watcher");
  return check.ok ? 0 : 1;
}
