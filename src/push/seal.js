//
//  seal.js
//  ksmail-watcher
//
//  End to end encryption of the notification, from this watcher to ONE device, so that neither the broker nor Apple can read it.
//
//  The broker relays every notification and Apple delivers it; both would otherwise see the sender, the subject and a line of every message. So what identifies the mail is sealed with a key only the device and this watcher hold (the encryption key ksMail shows next to the installation secret), and what travels in clear is a generic alert the system can show on its own. On the device, ksMail's notification service extension opens the seal before the banner is drawn and puts the real sender, subject and preview in its place. If it cannot (a phone restarted and not unlocked yet), the generic alert is what shows, and a tap still opens the message: the app opens the seal itself.
//
//  What is sealed, and what is not:
//
//    clear  aps.alert's localization keys only ("New Message" when the alert has none), sound, category, mutable-content (which is what makes the system run the extension), content-available
//    sealed aps.alert's texts (title, subtitle, body), thread-id, and the whole "ksmail" block (account, mailbox, UID, sender...)
//
//    payload = { aps: <clear>, ksmail: { v: 2, sealed: <base64> } }
//    sealed  = base64( nonce(12) || ciphertext || tag(16) ), AES-256-GCM, additional data "ksmail-sealed-notification:v2"
//    plain   = UTF-8 JSON { alert: {...texts}, thread-id, ksmail: <v1 block> }
//
//  The collapse id, which the broker sends to Apple as a header and cannot be sealed, is replaced by an HMAC of it under the same key: the same message still replaces its own banner, and the header no longer says which account and which UID.
//
//  THIS IS A CROSS LANGUAGE CONTRACT with the app (the ksMail app's SealedNotification.swift). Both sides pin the vector of test/seal.test.js, because getting it wrong does not fail loudly: every banner says "New Message" and nothing else.
//

import crypto from "node:crypto";

export const SEALED_VERSION = 2;
const ADDITIONAL_DATA = Buffer.from("ksmail-sealed-notification:v2", "utf8");
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

/// What the lock screen says when the seal cannot be opened. A localization key, so the phone says it in its own language; the sentence is the key, so a client without it still shows English.
export const GENERIC_TITLE_LOC_KEY = "New Message";

/// APNs refuses an alert payload over 4 KB, and so does the broker.
export const MAX_PAYLOAD_BYTES = 4096;

/// The encryption key as ksMail shows it (base64url, 43 characters) or in plain base64. null for anything that is not 32 bytes.
export function parseEncryptionKey(text) {
  if (typeof text !== "string") {
    return null;
  }
  const cleaned = text.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]+$/.test(cleaned)) {
    return null;
  }
  const bytes = Buffer.from(cleaned, "base64");
  return bytes.length === KEY_BYTES ? bytes : null;
}

export function sealBytes(key, plaintext, nonce = crypto.randomBytes(NONCE_BYTES)) {
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(ADDITIONAL_DATA);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64");
}

/// The reverse, for the tests and for nothing else: the watcher never reads a sealed notification.
export function openBytes(key, sealed) {
  const bytes = Buffer.from(sealed, "base64");
  const nonce = bytes.subarray(0, NONCE_BYTES);
  const tag = bytes.subarray(bytes.length - 16);
  const ciphertext = bytes.subarray(NONCE_BYTES, bytes.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(ADDITIONAL_DATA);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/// The collapse id the broker may see: 32 hexadecimal characters that are the same for the same message on the same device, and say nothing about it.
export function sealedCollapseId(key, collapseId) {
  return crypto.createHmac("sha256", key)
    .update(`collapse:${collapseId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function isLocalizationKey(name) {
  return /(^|-)loc-/.test(name);
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/// The texts are cut until the sealed payload fits in what APNs takes. The body goes first and goes furthest: a line of preview is worth less than knowing who wrote.
function shrink(alert) {
  for (const name of ["body", "subtitle", "title"]) {
    const text = alert[name];
    if (typeof text === "string" && text.length > 0) {
      const kept = Math.floor(text.length * 0.75);
      if (kept < 8) {
        delete alert[name];
      } else {
        alert[name] = `${text.slice(0, kept - 1)}…`;
      }
      return true;
    }
  }
  return false;
}

/// One device's copy of a notification. `payload` is the clear payload of payload.js; the result is what goes to the broker for that device.
export function sealNotification({ payload, collapseId = null, key, nonce = undefined }) {
  const aps = payload.aps ?? {};
  const clearAlert = {};
  const sealedAlert = {};
  for (const [name, value] of Object.entries(aps.alert ?? {})) {
    (isLocalizationKey(name) ? clearAlert : sealedAlert)[name] = value;
  }
  if (Object.keys(clearAlert).length === 0) {
    clearAlert["title-loc-key"] = GENERIC_TITLE_LOC_KEY;
  }

  const clearAps = { alert: clearAlert };
  for (const name of ["sound", "category", "content-available"]) {
    if (aps[name] !== undefined) {
      clearAps[name] = aps[name];
    }
  }
  // What makes the system hand the notification to the extension that opens the seal. Without it the generic alert is all there is.
  clearAps["mutable-content"] = 1;

  const inner = { alert: sealedAlert, ksmail: payload.ksmail ?? {} };
  if (aps["thread-id"] !== undefined) {
    inner["thread-id"] = aps["thread-id"];
  }

  let sealedPayload;
  for (;;) {
    const sealed = sealBytes(key, Buffer.from(JSON.stringify(inner), "utf8"), nonce);
    sealedPayload = { aps: clearAps, ksmail: { v: SEALED_VERSION, sealed } };
    if (byteLength(sealedPayload) <= MAX_PAYLOAD_BYTES || !shrink(sealedAlert)) {
      break;
    }
  }
  return {
    payload: sealedPayload,
    collapseId: collapseId ? sealedCollapseId(key, collapseId) : null,
  };
}
