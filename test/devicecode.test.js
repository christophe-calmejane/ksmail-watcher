//
//  devicecode.test.js
//  ksmail-watcher tests
//
//  The line ksMail shares to set a device up is read here, and nobody checks it by eye: a code the app writes and this side cannot read is a reader stuck at the first step, with a 240 character string they cannot debug. So the app's encoding is pinned to the vector below (the ksMail app's PushInstallationTests asserts it produces exactly this string), and the ways people paste it are tried here.
//

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { parseDeviceCode, DeviceCodeError } from "../src/push/devicecode.js";
import { applyDevice, addDevice, freeName, whyNotWritable, AddDeviceError } from "../src/commands/adddevice.js";
import { chmodSync } from "node:fs";
import { DEFAULT_BROKER_URL } from "../src/push/broker.js";

/// The vector, shared with the ksMail app.
const CODE = "ksmw1.eyJicm9rZXIiOiJodHRwczovL2tzbWFpbC1icm9rZXIuZXhhbXBsZS53b3JrZXJzLmRldiIsImVuY3J5cHRpb25LZXkiOiJBQUVDQXdRRkJnY0lDUW9MREEwT0R4QVJFaE1VRlJZWEdCa2FHeHdkSGg4IiwiaW5zdGFsbGF0aW9uU2VjcmV0IjoiUTFQWFlSNkhBVkFOVkVFODMyNjlKNFpaMiIsIm5hbWUiOiJpUGhvbmUifQ";

test("the code ksMail writes is the device it describes", () => {
  assert.deepEqual(parseDeviceCode(CODE), {
    broker: "https://ksmail-broker.example.workers.dev",
    name: "iPhone",
    installationSecret: "Q1PXYR6HAVANVEE83269J4ZZ2",
    encryptionKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  });
});

/// What arrives is rarely the code alone: the whole command, the whole mail, quoted by a messaging app.
test("the code is found in whatever was pasted around it", () => {
  const mail = `To receive this iPhone's ksMail notifications, run this:\n\nksmail-watcher add-device ${CODE}\n\nKeep it to yourself.`;
  assert.equal(parseDeviceCode(mail).name, "iPhone");
  assert.equal(parseDeviceCode(`“${CODE}”`).name, "iPhone");
  assert.equal(parseDeviceCode(`> ksmail-watcher add-device ${CODE}`).name, "iPhone");
});

test("a code cut or mangled is refused with a sentence, not a stack", () => {
  assert.throws(() => parseDeviceCode("nothing here"), DeviceCodeError);
  assert.throws(() => parseDeviceCode(CODE.slice(0, 60)), /damaged or cut|damaged/);
  assert.throws(() => parseDeviceCode("ksmw1.e30"), /names no broker/);
});

// MARK: Putting it in the configuration

const DEVICE = parseDeviceCode(CODE);
const EXAMPLE = {
  broker: {
    url: "https://PASTE-THE-BROKER-ADDRESS-KSMAIL-SHOWS",
    devices: { iPhone: { installationSecret: "PASTE THE INSTALLATION SECRET", encryptionKey: "PASTE THE KEY" } },
  },
  accounts: [{ id: "perso", address: "moi@kikisoft.fr" }],
};

test("the first device fills the broker and replaces the example's placeholders", () => {
  const { config, action, name } = applyDevice(EXAMPLE, DEVICE);
  assert.equal(action, "added");
  assert.equal(name, "iPhone");
  assert.equal(config.broker.url, "https://ksmail-broker.example.workers.dev");
  assert.deepEqual(config.broker.devices, {
    iPhone: {
      installationSecret: "Q1PXY-R6HAV-ANVEE-83269-J4ZZ2",
      encryptionKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    },
  });
  assert.equal(EXAMPLE.broker.url.includes("PASTE"), true, "the input is not touched");
});

/// The same device shared twice (the key changed after the option was turned off and on, or the reader just did it twice) is one entry.
test("the same secret again updates its entry, under the name it already has", () => {
  const first = applyDevice(EXAMPLE, DEVICE, { name: "Mon iPhone" }).config;
  const again = applyDevice(first, { ...DEVICE, encryptionKey: "BBECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" });
  assert.equal(again.action, "updated");
  assert.equal(again.name, "Mon iPhone");
  assert.equal(Object.keys(again.config.broker.devices).length, 1);
  assert.equal(again.config.broker.devices["Mon iPhone"].encryptionKey.startsWith("BBEC"), true);
});

test("a name taken by another device is a question, not an overwrite", () => {
  const first = applyDevice(EXAMPLE, DEVICE).config;
  const other = { ...DEVICE, installationSecret: "6HFQ4EAD59018N641JBHV5SJR" };
  assert.throws(() => applyDevice(first, other), (error) => error instanceof AddDeviceError && error.conflict === "iPhone");
  assert.equal(applyDevice(first, other, { replace: true }).action, "replaced");
  const both = applyDevice(first, other, { name: freeName(first, "iPhone") });
  assert.deepEqual(Object.keys(both.config.broker.devices), ["iPhone", "iPhone 2"]);
});

test("a device of another broker is refused: one watcher, one broker", () => {
  const first = applyDevice(EXAMPLE, DEVICE).config;
  assert.throws(
    () => applyDevice(first, { ...DEVICE, broker: "https://another.example" }),
    /one watcher talks to one broker/,
  );
});

/// The example ships with the broker of the App Store ksMail, which a clone must be able to use as it is.
test("the shipped example takes a device of the App Store broker without touching its address", () => {
  const shipped = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));
  assert.equal(shipped.broker.url, DEFAULT_BROKER_URL);
  const { config, notes } = applyDevice(shipped, { ...DEVICE, broker: DEFAULT_BROKER_URL });
  assert.equal(config.broker.url, DEFAULT_BROKER_URL);
  assert.deepEqual(Object.keys(config.broker.devices), ["iPhone"], "the placeholder device is gone");
  assert.equal(notes.some((note) => note.startsWith("broker.url")), false, notes.join("\n"));
});

/// Nobody chose the default: a build of ksMail with a broker of its own must not stumble on it at its first device.
test("the default broker gives way to the first device's own, and only to the first", () => {
  const shipped = { ...EXAMPLE, broker: { ...EXAMPLE.broker, url: DEFAULT_BROKER_URL } };
  const first = applyDevice(shipped, DEVICE);
  assert.equal(first.config.broker.url, "https://ksmail-broker.example.workers.dev");
  assert.ok(first.notes.includes("broker.url set to https://ksmail-broker.example.workers.dev"), first.notes.join("\n"));

  const settled = { ...first.config, broker: { ...first.config.broker, url: DEFAULT_BROKER_URL } };
  assert.throws(() => applyDevice(settled, { ...DEVICE, installationSecret: "6HFQ4EAD59018N641JBHV5SJR" }), /one watcher talks to one broker/);
});

test("accounts that list their devices are named, since the new one is not in their lists", () => {
  const listed = { ...EXAMPLE, accounts: [{ id: "papa", devices: ["Mac"] }, { id: "commun" }] };
  const { notes } = applyDevice(listed, DEVICE);
  assert.ok(notes.some((note) => note.startsWith("papa list their own devices")), notes.join("\n"));
});

// MARK: The command

/// The broker, as the command asks it: does it know this device.
function brokerAnswering(status) {
  return () => ({
    notify: async ({ dryRun }) => {
      assert.equal(dryRun, true, "a dry run: nothing may show on the device");
      return status === 200
        ? { ok: true, status, answer: { environment: "production" } }
        : { ok: false, status, reason: "no device is registered" };
    },
  });
}

async function run(configText, { input = new PassThrough(), status = 200, ...options } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ksmail-add-device-"));
  const path = join(directory, "config.json");
  writeFileSync(path, configText, { mode: 0o600 });
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk) => { printed += chunk; });
  const code = await addDevice({
    configPath: path, input, output, brokerFor: brokerAnswering(status), ...options,
  });
  return { status: code, printed, path };
}

test("the command writes the device, keeps the file private and asks the broker about it", async () => {
  const { status, printed, path } = await run(JSON.stringify(EXAMPLE), { code: CODE });
  assert.equal(status, 0);
  assert.match(printed, /Added "iPhone"/);
  assert.match(printed, /the broker knows this device \(production\)/);
  assert.match(printed, /systemctl restart ksmail-watcher/);
  const written = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(written.broker.devices.iPhone.installationSecret, "Q1PXY-R6HAV-ANVEE-83269-J4ZZ2");
  assert.equal(statSync(path).mode & 0o777, 0o600, "it holds keys: it stays private");
});

test("a device the broker does not know is said at once, not at the first mail", async () => {
  const { status, printed } = await run(JSON.stringify(EXAMPLE), { code: CODE, status: 401 });
  assert.equal(status, 1);
  assert.match(printed, /the broker does not know this device/);
});

test("without a code on the command line, the pasted message is read", async () => {
  const input = new PassThrough();
  const pending = run(JSON.stringify(EXAMPLE), { input });
  input.write(`Run this: ksmail-watcher add-device ${CODE}\n`);
  const { status, printed, path } = await pending;
  assert.equal(status, 0);
  assert.match(printed, /Paste the line ksMail shared/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).broker.url, "https://ksmail-broker.example.workers.dev");
});

/// A Docker install mounts the configuration read only, or hands it to a user the container is not: the answer must come before the code is pasted, and say what to do.
test("a configuration this user cannot write is refused before anything is asked", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ksmail-add-device-"));
  const path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify(EXAMPLE), { mode: 0o400 });
  try {
    assert.match(whyNotWritable(path, { docker: true }), /cannot be written.*chown -R 1000:1000 config state/);
    assert.equal(whyNotWritable(join(directory, "absent.json")), null, "a missing file is said later, as before");
    const output = new PassThrough();
    let printed = "";
    output.on("data", (chunk) => { printed += chunk; });
    const status = await addDevice({ configPath: path, input: new PassThrough(), output, brokerFor: brokerAnswering(200) });
    assert.equal(status, 1);
    assert.match(printed, /FAIL .*cannot be written/);
    assert.doesNotMatch(printed, /Paste the line/);
  } finally {
    chmodSync(path, 0o600);
  }
});

test("a name conflict outside a terminal says how to settle it, and changes nothing", async () => {
  const configured = applyDevice(EXAMPLE, DEVICE).config;
  const other = `ksmw1.${Buffer.from(JSON.stringify({
    broker: "https://ksmail-broker.example.workers.dev",
    encryptionKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    installationSecret: "6HFQ4EAD59018N641JBHV5SJR",
    name: "iPhone",
  })).toString("base64url")}`;
  const { status, printed, path } = await run(JSON.stringify(configured), { code: other });
  assert.equal(status, 1);
  assert.match(printed, /--replace/);
  assert.match(printed, /--name "iPhone 2"/);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), configured);
});
