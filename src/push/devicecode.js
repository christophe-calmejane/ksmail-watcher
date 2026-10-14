//
//  devicecode.js
//  ksmail-watcher
//
//  The one line ksMail hands over to set a device up on this watcher, so that nobody ever types a secret or a key by hand.
//
//  The app shows a "Send to the Watcher" button (the share sheet: Mail, Messages, AirDrop, Notes...) and a "Copy the Watcher Command" one (Universal Clipboard to a Mac, then into an SSH session). Both carry the same line:
//
//    ksmail-watcher add-device ksmw1.<base64url, no padding, of UTF-8 JSON>
//
//    { "broker": "https://…", "encryptionKey": "<43 characters>", "installationSecret": "<25 characters>", "name": "iPhone" }
//
//  The keys are written in that (sorted) order by the app; this side reads any order. Only letters, digits, "-", "_" and "." in the code: nothing a mail client, a messaging app or a shell would rewrite, no quote to be turned into a curly one.
//
//  A CROSS LANGUAGE CONTRACT with the app (the ksMail app's PushInstallation.swift), pinned to the vector of test/devicecode.test.js on both sides.
//

import { normalizeInstallationSecret } from "./broker.js";
import { parseEncryptionKey } from "./seal.js";

export const DEVICE_CODE_PREFIX = "ksmw1.";

const CODE_PATTERN = /ksmw1\.[A-Za-z0-9_-]+/;

export class DeviceCodeError extends Error {}

/// Finds the code in whatever was pasted: the code alone, the whole command, or the whole message ksMail sent. Returns the device it describes, checked, or throws a sentence saying what is wrong.
export function parseDeviceCode(text) {
  const match = typeof text === "string" ? text.match(CODE_PATTERN) : null;
  if (!match) {
    throw new DeviceCodeError(
      "no ksMail device code here: it starts with ksmw1. and ksMail shares it from " +
        "Settings > Push Notifications > Send to the Watcher",
    );
  }
  let fields;
  try {
    fields = JSON.parse(Buffer.from(match[0].slice(DEVICE_CODE_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new DeviceCodeError("this device code is damaged or cut: copy it again, in one piece");
  }
  if (!fields || typeof fields !== "object") {
    throw new DeviceCodeError("this device code is damaged: copy it again");
  }

  let broker;
  try {
    broker = new URL(fields.broker);
  } catch {
    throw new DeviceCodeError("this device code names no broker: copy it again");
  }
  if (broker.protocol !== "https:") {
    throw new DeviceCodeError(`this device code names a broker that is not https (${fields.broker})`);
  }
  const installationSecret = normalizeInstallationSecret(fields.installationSecret);
  const encryptionKey = parseEncryptionKey(fields.encryptionKey);
  if (!installationSecret || !encryptionKey) {
    throw new DeviceCodeError("this device code is damaged: its secret or its key is not whole, copy it again");
  }
  const name = typeof fields.name === "string" && fields.name.trim() !== "" ? fields.name.trim() : "Device";
  return {
    broker: broker.toString().replace(/\/+$/, ""),
    name,
    installationSecret,
    encryptionKey: fields.encryptionKey.trim(),
  };
}
