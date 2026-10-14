//
//  broker.js
//  ksmail-watcher
//
//  The watcher's only way to a lock screen: the ksMail broker, over HTTPS (docs/PROTOCOL.md, "The broker"). The watcher decides that a message deserves a notification and what it says; the broker, which is the only component holding the Apple key, turns that into a push for ONE installation of the app, named by its installation secret.
//
//  So the watcher holds no Apple secret at all, and never learns a device token: it holds, per device, the secret ksMail shows in its settings, and that secret can do one thing, which is ask the broker for a rate limited notification on that one device.
//
//  The answers the broker gives, and what each one is worth here:
//    200  sent to Apple
//    401  the broker knows no device under this secret: it was mistyped in the configuration, or ksMail was never opened with its watcher notifications on, or it was turned off there
//    410  Apple says the app is gone from that device; the broker forgot it, and the next launch of ksMail registers it again
//    429  too many notifications for that device this hour, or too many requests from this address this minute
//    other  the broker or Apple failed; the body says which
//

/// Crockford base32, the alphabet the app shows the secret in.
export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const INSTALLATION_SECRET_LENGTH = 25;

/// The broker the App Store ksMail registers its devices with, run by the publisher of the app on Cloudflare.
/// A configuration that names no broker sends there.
/// A build of ksMail with a broker of its own names that one in broker.url instead.
export const DEFAULT_BROKER_URL = "https://ksmail-broker.kikisoft.com";

const REQUEST_TIMEOUT_MS = 15_000;

/// An installation secret as it is SENT: upper case, no separators, and the characters people substitute put back. null for anything that is not one, so a configuration that holds something else is refused at startup instead of being answered 401 at the first message. The same rule as the broker's (docs/PROTOCOL.md, "Device credentials").
export function normalizeInstallationSecret(text) {
  if (typeof text !== "string") {
    return null;
  }
  const cleaned = text
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (cleaned.length !== INSTALLATION_SECRET_LENGTH) {
    return null;
  }
  for (const character of cleaned) {
    if (!ALPHABET.includes(character)) {
      return null;
    }
  }
  return cleaned;
}

export class BrokerClient {
  constructor({ url, log }) {
    // Kept without a trailing slash, so "/notify" can be appended.
    this.url = url.replace(/\/+$/, "");
    this.log = log;
  }

  async request(method, path, body) {
    let response;
    try {
      response = await fetch(`${this.url}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error?.name === "TimeoutError"
        ? "timeout"
        : (error?.cause?.message ?? error?.message ?? String(error));
      return { ok: false, status: 0, reason };
    }
    let answer = {};
    try {
      answer = await response.json();
    } catch {
      // A proxy's HTML error page, typically. The status says enough.
    }
    return {
      ok: response.status === 200,
      status: response.status,
      // The broker's sentence, then Apple's word for it when there is one ("Apple refused the notification: BadTopic").
      reason: [answer.error, answer.reason].filter(Boolean).join(": ") || null,
      retryAfter: response.headers.get("retry-after"),
      answer,
    };
  }

  /// Is the broker there at all. What "doctor" asks first.
  health() {
    return this.request("GET", "/health");
  }

  /// One notification for one device. Never throws: every outcome is an answer the notifier logs.
  notify({ installationSecret, payload, collapseId = null, expiresIn = null, dryRun = false }) {
    const body = { installationSecret };
    if (dryRun) {
      body.dryRun = true;
    } else {
      body.payload = payload;
      if (collapseId) {
        body.collapseId = collapseId;
      }
      if (expiresIn !== null) {
        body.expiresIn = expiresIn;
      }
    }
    return this.request("POST", "/notify", body);
  }
}
