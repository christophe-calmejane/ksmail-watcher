//
//  run.js
//  ksmail-watcher
//
//  The long running command: what systemd (or Docker) starts and never stops. It wires the pieces together and then does nothing but log, because everything interesting happens in the monitors.
//

import { loadConfig } from "../config.js";
import { logger, setLogLevel } from "../log.js";
import { State } from "../state.js";
import { BrokerClient } from "../push/broker.js";
import { Notifier } from "../push/notifier.js";
import { AccountMonitor } from "../imap/monitor.js";

const HEARTBEAT_MS = 6 * 60 * 60 * 1000;

export async function run({ configPath }) {
  const config = loadConfig(configPath);
  setLogLevel(config.logLevel);
  const log = logger("watcher");

  const state = new State(config.stateFile, log.child("state")).load();

  const broker = new BrokerClient({ url: config.broker.url, log: log.child("broker") });
  // Said now rather than at the first mail, but not fatal: a Pi that boots before its network is up must still come up, and every push tries the broker again on its own.
  const health = await broker.health();
  if (!health.ok) {
    log.warn("the broker does not answer, pushes will fail until it does", {
      url: config.broker.url, status: health.status, reason: health.reason,
    });
  }

  const notifier = new Notifier({
    broker,
    notifications: config.notifications,
    log: log.child("push"),
  });

  const accounts = config.accounts.filter((account) => account.enabled);
  if (accounts.length === 0) {
    log.error("every account in the configuration is disabled, there is nothing to watch");
    return 1;
  }
  // The refresh token may live in the configuration or in the state file ("ksmail-watcher oauth --account" writes it there). An account with neither is a setup that was never finished, and that is a sentence at startup rather than a give-up at the first connection.
  const withoutToken = accounts.filter((account) =>
    account.auth.type === "oauth" && !account.auth.refreshToken && !state.refreshToken(account.id));
  if (withoutToken.length > 0) {
    for (const account of withoutToken) {
      log.error(`account "${account.id}" has no refresh token yet, run "ksmail-watcher oauth --account ${account.id}"`);
    }
    return 1;
  }

  const monitors = accounts.map((account) => new AccountMonitor({
    account,
    config,
    state,
    log: logger(`imap:${account.id}`),
    notifier,
  }));

  log.info("starting", {
    accounts: accounts.length,
    mailboxes: accounts.reduce((total, account) => total + account.mailboxes.length, 0),
    devices: config.broker.devices.length,
    broker: config.broker.url,
  });

  for (const monitor of monitors) {
    monitor.start();
  }

  // Deliberately NOT unref'd: it is the one handle that keeps the process alive once every mailbox has given up (one account, one dead refresh token). Without it Node sees an empty event loop and exits 0, the container runtime restarts it, and the log fills with the same two lines every ten seconds until someone happens to look. A watcher with nothing left to watch stays up and says so.
  const heartbeat = setInterval(() => {
    const mailboxes = monitors.flatMap((monitor) => monitor.monitors);
    log.info("still here", {
      connectedMailboxes: mailboxes.filter((mailbox) => mailbox.status.connected).length,
      givenUpMailboxes: mailboxes.filter((mailbox) => mailbox.status.givenUp).length,
      // On the Raspberry Pi this line is the only place the watcher's appetite ever shows. Four of them in a day is a trend, and a trend is what tells a leak from a busy morning (docs/DESIGN.md, "Memory").
      residentMB: Math.round(process.memoryUsage().rss / 1048576),
    });
  }, HEARTBEAT_MS);

  let stopping = false;
  const stop = (signal) => {
    if (stopping) {
      return;
    }
    stopping = true;
    log.info("stopping", { signal });
    clearInterval(heartbeat);
    for (const monitor of monitors) {
      monitor.stop();
    }
    try {
      state.save();
    } catch (error) {
      log.error("could not write the state file on the way out", { error: error.message });
    }
    // Give the sockets a moment to close politely, then leave. The container runtime kills at 10 seconds, so this stays short.
    setTimeout(() => process.exit(0), 500).unref?.();
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("unhandledRejection", (error) => {
    log.error("unhandled rejection", { error: error?.stack ?? String(error) });
  });

  return new Promise(() => {});
}
