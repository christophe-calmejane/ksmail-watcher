//
//  state.js
//  ksmail-watcher
//
//  The little that has to survive a restart:
//
//  - the highest UID already pushed for each mailbox, so a restart neither replays this morning's mail nor stays silent about what arrived while the process was down,
//  - the current refresh token of each OAuth account, because Microsoft rotates it at every refresh and the configuration file only ever holds the first one.
//
//  Nothing about devices: which APNs world a device token belongs to is the broker's to remember now, and the watcher never sees a token.
//
//  Writes are atomic (write beside, rename over): a Pi that loses power mid-write must not come back with half a JSON file and no memory.
//

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const EMPTY = { version: 1, mailboxes: {}, oauth: {} };

export class State {
  constructor(path, log) {
    this.path = path;
    this.log = log;
    this.data = structuredClone(EMPTY);
    this.writeScheduled = false;
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      // Written by a watcher that still talked to Apple itself: the environment of each device token, which is no business of this one. Dropped at the next write.
      delete parsed.deviceEnvironments;
      this.data = { ...structuredClone(EMPTY), ...parsed };
    } catch (error) {
      if (error.code !== "ENOENT") {
        // A corrupt state file is not worth refusing to start over: the cost is one silent mailbox pass, not a lost mail.
        this.log?.warn("state file unreadable, starting from an empty one", { error: error.message });
      }
    }
    return this;
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    this.adoptNewerRefreshTokens();
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  /// Two processes write this file: the watcher, and "ksmail-watcher oauth --account", which puts a fresh refresh token here while the watcher may well be running. A plain write of what this process remembers would erase that token at the next mail. So a token on disk that is newer than the one in memory is taken, not overwritten.
  adoptNewerRefreshTokens() {
    let onDisk;
    try {
      onDisk = JSON.parse(readFileSync(this.path, "utf8")).oauth ?? {};
    } catch {
      return;
    }
    for (const [accountId, entry] of Object.entries(onDisk)) {
      const mine = this.data.oauth[accountId];
      if (!mine || (entry.updatedAt ?? "") > (mine.updatedAt ?? "")) {
        this.data.oauth[accountId] = entry;
      }
    }
  }

  /// Coalesces the bursts: ten new messages in one IDLE wake write once.
  scheduleSave() {
    if (this.writeScheduled) {
      return;
    }
    this.writeScheduled = true;
    const timer = setTimeout(() => {
      this.writeScheduled = false;
      try {
        this.save();
      } catch (error) {
        this.log?.error("could not write the state file", { path: this.path, error: error.message });
      }
    }, 250);
    timer.unref?.();
  }

  mailboxKey(accountId, mailbox) {
    return `${accountId} ${mailbox}`;
  }

  mailboxState(accountId, mailbox) {
    return this.data.mailboxes[this.mailboxKey(accountId, mailbox)] ?? null;
  }

  setMailboxState(accountId, mailbox, value) {
    this.data.mailboxes[this.mailboxKey(accountId, mailbox)] = value;
    this.scheduleSave();
  }

  refreshToken(accountId) {
    return this.data.oauth[accountId]?.refreshToken ?? null;
  }

  setRefreshToken(accountId, refreshToken) {
    this.data.oauth[accountId] = { refreshToken, updatedAt: new Date().toISOString() };
    this.scheduleSave();
  }
}
