//
//  notifier.js
//  ksmail-watcher
//
//  One message in, one notification per device out. This is where the two sides meet, and it is deliberately the only place that knows both: what deserves a push (the monitors) and where it goes (the broker, ./broker.js). Each device gets its own copy, sealed with its own key (./seal.js): the broker and Apple carry it without being able to read it.
//

import {
  buildNewMailPayload, newMailDelivery, buildWatcherAlertPayload, watcherAlertDelivery,
} from "./payload.js";
import { sealNotification } from "./seal.js";

// A device the broker does not know is said once an hour in the log, not at every message: the cure is on the phone, and a log that repeats it forty times a day is a log nobody reads.
const UNKNOWN_DEVICE_WARNING_MS = 60 * 60 * 1000;

export class Notifier {
  constructor({ broker, notifications, log }) {
    this.broker = broker;
    this.notifications = notifications;
    this.log = log;
    // Accounts already told about, so four watched folders of one dead account make one alert and not four.
    this.alertedAccounts = new Set();
    this.warnedUnknownAt = new Map();
  }

  async notifyNewMessage({ account, message }) {
    const payload = buildNewMailPayload({
      account,
      message,
      sound: this.notifications.sound,
      preview: this.notifications.preview,
    });
    const delivery = newMailDelivery({
      account,
      message,
      expirationSeconds: this.notifications.expirationSeconds,
    });

    const { sent, failed } = await this.send(account.devices, { payload, ...delivery });
    this.log.info("pushed", {
      account: account.id,
      mailbox: message.mailbox,
      uid: message.uid,
      sent,
      failed,
    });
    return { sent, failed };
  }

  /// The watcher has given up on an account (dead refresh token, refused password): the account's own devices are told, once per account and per run. Silence is the one failure the owner cannot see, so this is the push that has to go out when nothing else can.
  async notifyAccountFailure({ account, reason }) {
    if (this.alertedAccounts.has(account.id)) {
      return { sent: 0, failed: 0 };
    }
    this.alertedAccounts.add(account.id);

    const { sent, failed } = await this.send(account.devices, {
      payload: buildWatcherAlertPayload({ account, reason }),
      ...watcherAlertDelivery({ account }),
    });
    this.log.info("account failure pushed", { account: account.id, reason, sent, failed });
    return { sent, failed };
  }

  async send(devices, { payload, collapseId, expiresIn }) {
    const results = await Promise.all(devices.map((device) => {
      const sealed = sealNotification({ payload, collapseId, key: device.encryptionKey });
      return this.broker.notify({
        installationSecret: device.installationSecret,
        payload: sealed.payload,
        collapseId: sealed.collapseId,
        expiresIn,
      });
    }));

    let sent = 0;
    let failed = 0;
    for (const [index, result] of results.entries()) {
      if (result.ok) {
        sent += 1;
      } else {
        failed += 1;
        this.explain(devices[index], result);
      }
    }
    return { sent, failed };
  }

  /// What the log says about a device the broker did not push to. The device is named by its name in broker.devices, never by its secret.
  explain(device, result) {
    switch (result.status) {
      case 401: {
        const last = this.warnedUnknownAt.get(device.name) ?? 0;
        if (Date.now() - last < UNKNOWN_DEVICE_WARNING_MS) {
          return;
        }
        this.warnedUnknownAt.set(device.name, Date.now());
        this.log.warn(
          "the broker knows no device under this secret: open ksMail on it, check that " +
            "Settings > Push Notifications is on, and compare the secret it shows with broker.devices",
          { device: device.name },
        );
        return;
      }
      case 410:
        this.log.info("device dropped: Apple says ksMail is gone from it. It comes back by itself the next time ksMail opens there", {
          device: device.name,
        });
        return;
      case 429:
        this.log.warn("the broker refused: too many notifications", {
          device: device.name,
          retryAfter: result.retryAfter,
          reason: result.reason,
        });
        return;
      default:
        this.log.warn("push refused", {
          device: device.name,
          status: result.status,
          reason: result.reason,
        });
    }
  }
}
