//
//  testpush.js
//  ksmail-watcher
//
//  Sends one notification that looks exactly like a real one, without waiting for mail. This is the command that tells apart "the Pi cannot reach the broker" from "the device is not registered with it": if this arrives on the phone, everything between this machine and the lock screen is correct.
//

import { loadConfig } from "../config.js";
import { logger, setLogLevel } from "../log.js";
import { BrokerClient } from "../push/broker.js";
import { buildTestPayload } from "../push/payload.js";
import { sealNotification } from "../push/seal.js";

export async function testPush({ configPath, text, accountId }) {
  const config = loadConfig(configPath);
  setLogLevel(config.logLevel);
  const log = logger("test-push");

  const account = accountId
    ? config.accounts.find((entry) => entry.id === accountId)
    : config.accounts[0];
  if (!account) {
    log.error("no such account in the configuration", { accountId });
    return 1;
  }

  const broker = new BrokerClient({ url: config.broker.url, log });
  const payload = buildTestPayload({ account, text: text ?? "ksmail-watcher is alive" });
  // The devices a real push for this account goes to, and no others, or this would prove the wrong thing.
  let failures = 0;
  for (const device of account.devices) {
    const result = await broker.notify({
      installationSecret: device.installationSecret,
      // Sealed like any real one, or this would prove the wrong thing: a test that arrives in clear says nothing about the extension that opens the seal on the device.
      payload: sealNotification({ payload, key: device.encryptionKey }).payload,
      expiresIn: 300,
    });
    if (result.ok) {
      log.info("delivered to Apple", { device: device.name, apnsId: result.answer.apnsId });
    } else {
      failures += 1;
      log.error("refused", { device: device.name, status: result.status, reason: result.reason });
    }
  }
  return failures === 0 ? 0 : 1;
}
