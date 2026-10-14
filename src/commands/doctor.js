//
//  doctor.js
//  ksmail-watcher
//
//  Answers the only question that matters before leaving a Pi alone for a month: which of the legs is broken. It checks the broker, that it knows every device of the configuration, and every mailbox, prints what it found, and exits non zero if anything is wrong. It never sends a push and never marks a message read.
//

import { loadConfig } from "../config.js";
import { logger, setLogLevel } from "../log.js";
import { State } from "../state.js";
import { BrokerClient } from "../push/broker.js";
import { ImapConnection } from "../imap/client.js";
import { AccountAuth } from "../imap/monitor.js";

function line(text) {
  process.stdout.write(`${text}\n`);
}

function ok(text) {
  line(`  ok    ${text}`);
}

function bad(text) {
  line(`  FAIL  ${text}`);
}

/// The broker, then each device through it. A device the broker does not know is the silent failure this whole check exists for: the watcher would push into a 401 for ever. The question is asked as a dry run, which puts nothing on any lock screen.
async function checkBroker(config, log) {
  line(`Broker ${config.broker.url}`);
  const broker = new BrokerClient({ url: config.broker.url, log });
  const health = await broker.health();
  if (!health.ok || health.answer?.service !== "ksmail-broker") {
    bad(health.status === 0
      ? `unreachable: ${health.reason}`
      : `answered ${health.status}, which is not a ksMail broker`);
    return false;
  }
  ok(`a ksMail broker answers (version ${health.answer.version})`);

  let allGood = true;
  for (const device of config.broker.devices) {
    const result = await broker.notify({ installationSecret: device.installationSecret, dryRun: true });
    if (result.ok) {
      ok(`${device.name}: registered ${result.answer.registeredAt} (${result.answer.environment})`);
    } else if (result.status === 401) {
      bad(
        `${device.name}: the broker knows no device under this secret. Open ksMail on it, ` +
          "check that Settings > Push Notifications is on, and compare the secret shown there",
      );
      allGood = false;
    } else {
      bad(`${device.name}: ${result.status} ${result.reason ?? ""}`.trim());
      allGood = false;
    }
  }
  return allGood;
}

async function checkAccount(account, config, state, log) {
  line(`Account ${account.id} (${account.address})`);
  const connection = new ImapConnection({
    host: account.host,
    port: account.port,
    useTLS: account.tls,
    log: log.child(account.id),
  });
  try {
    await connection.connect();
    await connection.capability();
    if (account.auth.type === "password") {
      await connection.login(account.username, account.auth.password);
    } else {
      const auth = new AccountAuth({ account, state, log });
      if (!auth.currentRefreshToken()) {
        bad(`no refresh token in the configuration nor in the state file, run "ksmail-watcher oauth --account ${account.id}"`);
        connection.destroy();
        return false;
      }
      await connection.authenticateXOAUTH2(account.username, await auth.token({ force: true }));
      ok(`OAuth refresh token accepted (from ${state.refreshToken(account.id) ? "the state file" : "the configuration"}), XOAUTH2 login accepted`);
    }
    await connection.capability();
    ok(`connected to ${account.host}:${account.port}`);
    ok(`pushed to ${account.devices.map((device) => device.name).join(", ")}`);
    if (connection.supports("IDLE")) {
      ok("server advertises IDLE, real push will work");
    } else {
      bad(`server does not advertise IDLE, the watcher will poll every ${config.pollSeconds}s`);
    }

    let allGood = true;
    for (const mailbox of account.mailboxes) {
      try {
        const summary = await connection.select(mailbox, { readOnly: true });
        const remembered = state.mailboxState(account.id, mailbox);
        ok(`${mailbox}: ${summary.exists} messages, uidnext ${summary.uidNext}, uidvalidity ${summary.uidValidity}` +
          (remembered ? `, watching from uid ${remembered.lastUid}` : ", never watched yet"));
      } catch (error) {
        bad(`${mailbox}: ${error.message}`);
        allGood = false;
      }
    }
    await connection.logout();
    return allGood;
  } catch (error) {
    bad(error.message);
    connection.destroy();
    return false;
  }
}

export async function doctor({ configPath }) {
  const config = loadConfig(configPath);
  setLogLevel(config.logLevel === "debug" ? "debug" : "warn");
  const log = logger("doctor");
  const state = new State(config.stateFile, log).load();

  line("");
  let allGood = await checkBroker(config, log);

  for (const account of config.accounts) {
    line("");
    if (!account.enabled) {
      line(`Account ${account.id} (disabled in the configuration)`);
      continue;
    }
    allGood = (await checkAccount(account, config, state, log)) && allGood;
  }

  line("");
  line(allGood ? "Everything the watcher needs is in place." : "Something is missing, see the FAIL lines above.");
  return allGood ? 0 : 1;
}
