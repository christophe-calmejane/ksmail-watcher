#!/usr/bin/env node
//
//  ksmail-watcher
//
//  Entry point. Five commands and no framework: "run" is what the Pi starts, the others are what a human runs the day a device is added, the day an account is added, or the day something is wrong.
//

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG_PATH, ConfigError } from "../src/config.js";
import { run } from "../src/commands/run.js";
import { doctor } from "../src/commands/doctor.js";
import { testPush } from "../src/commands/testpush.js";
import { oauth } from "../src/commands/oauth.js";
import { addDevice } from "../src/commands/adddevice.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const USAGE = `ksmail-watcher <command> [options]

Commands:
  run                     Watch every account and push new mail (the service).
  add-device [code]       Add a device from the line ksMail shares (asks for it when not given).
  doctor                  Check the broker, every device and every mailbox, then exit.
  test-push               Send one notification that looks like a real one.
  oauth --account <id>    Mint a new refresh token for a configured account, into the state file.
  oauth <provider>        Mint the refresh token of a google or microsoft account, to paste into the config.

Options:
  --config <path>         Configuration file (default: $KSMAIL_WATCHER_CONFIG or ${DEFAULT_CONFIG_PATH})
  --account <id>          test-push: which account the notification claims to come from
                          oauth: the configured account to mint for (provider and client come from the config)
  --text <text>           test-push: the body of the test notification
  --client-id <id>        oauth: the OAuth client id
  --client-secret <s>     oauth: the client secret (Google desktop clients have one, Microsoft public ones do not)
  --tenant <tenant>       oauth: Microsoft tenant (default common)
  --port <port>           oauth: loopback port for the redirect (default 8765)
  --manual                oauth: no loopback server, the redirect URL is pasted back instead
  --address <address>     oauth: pre-fills the account to sign in with
  --name <name>           add-device: the device's name in the configuration (default: its model)
  --replace               add-device: take the place of a device of the same name (ksMail reinstalled on it)
  -h, --help              This text
  -v, --version           Version
`;

function parseArguments(argv) {
  const options = {
    configPath: process.env.KSMAIL_WATCHER_CONFIG ?? DEFAULT_CONFIG_PATH,
    port: 8765,
    tenant: "common",
    manual: false,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => argv[index += 1];
    switch (argument) {
      case "--config": options.configPath = next(); break;
      case "--account": options.accountId = next(); break;
      case "--text": options.text = next(); break;
      case "--client-id": options.clientId = next(); break;
      case "--client-secret": options.clientSecret = next(); break;
      case "--tenant": options.tenant = next(); break;
      case "--port": options.port = Number(next()); break;
      case "--address": options.address = next(); break;
      case "--manual": options.manual = true; break;
      case "--name": options.name = next(); break;
      case "--replace": options.replace = true; break;
      case "-h": case "--help": options.help = true; break;
      case "-v": case "--version": options.version = true; break;
      default:
        if (argument.startsWith("-")) {
          throw new Error(`unknown option ${argument}`);
        }
        positional.push(argument);
    }
  }
  return { options, positional };
}

async function main() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const { options, positional } = parsed;

  if (options.version) {
    const { version } = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
    process.stdout.write(`ksmail-watcher ${version}\n`);
    return 0;
  }
  const command = positional[0] ?? "run";
  if (options.help || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (command) {
    case "run":
      return run(options);
    case "doctor":
      return doctor(options);
    case "test-push":
      return testPush(options);
    case "oauth":
      return oauth({ ...options, provider: positional[1] });
    case "add-device":
      return addDevice({ ...options, code: positional.slice(1).join(" ") || null });
    default:
      process.stderr.write(`unknown command ${command}\n\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => {
    process.exitCode = code ?? 0;
  },
  (error) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`${error.stack ?? error.message}\n`);
    }
    process.exitCode = 1;
  },
);
