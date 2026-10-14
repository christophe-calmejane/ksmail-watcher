//
//  log.js
//  ksmail-watcher
//
//  One line per event on stdout, which is what both journald and "docker logs" collect. The format is deliberately flat text and not JSON: the only reader is a human looking at why a push did not arrive.
//
//  NOTHING private is ever logged. Not a subject, not a sender, not a password, not a token, not an installation secret: the watcher exists to carry a preview to one device, not to write it down on the Pi. Message identity in the logs is the account name plus the UID, which is enough to follow one message across a whole session, and a device is named by its name in broker.devices.
//

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let threshold = LEVELS.info;

export function setLogLevel(level) {
  if (level in LEVELS) {
    threshold = LEVELS[level];
  }
}

function emit(level, scope, message, fields) {
  if (LEVELS[level] > threshold) {
    return;
  }
  const parts = [
    new Date().toISOString(),
    level.toUpperCase().padEnd(5),
    `[${scope}]`,
    message,
  ];
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) {
        parts.push(`${key}=${value}`);
      }
    }
  }
  const line = parts.join(" ");
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

/// A logger bound to one scope ("imap:perso", "push", "broker").
export function logger(scope) {
  return {
    error: (message, fields) => emit("error", scope, message, fields),
    warn: (message, fields) => emit("warn", scope, message, fields),
    info: (message, fields) => emit("info", scope, message, fields),
    debug: (message, fields) => emit("debug", scope, message, fields),
    child: (suffix) => logger(`${scope}:${suffix}`),
  };
}
