//
//  monitor.js
//  ksmail-watcher
//
//  One monitor per mailbox: connect, authenticate, EXAMINE, then sit in IDLE forever and push what arrives. Everything hard about this component is in this file, and it is not the protocol:
//
//  1. What counts as NEW. The answer is the UID, kept across restarts with the UIDVALIDITY it was valid under. A server that renumbers its mailbox (new UIDVALIDITY) invalidates the whole memory, and the only safe reaction is to take the current top as the new starting point and push nothing: the alternative is fifty notifications for mail read last week.
//  2. What counts as NEWS. A message that is already \Seen was read on another device before the push went out. A message whose INTERNALDATE is a week old was moved into the mailbox by another client, not received. Neither is worth waking a phone for, both still move the UID mark forward.
//  3. Coming back from a disconnection. Between "nothing arrived" and "two hundred messages arrived" the honest answer is the last few, which is what maxCatchUpPerMailbox and catchUpMaxAgeHours mean.
//
//  The connection is opened with EXAMINE and not SELECT: the watcher must never mark anything \Seen, never clear \Recent, never change what the app will see when it opens.
//

import { ImapConnection, ImapError } from "./client.js";
import { parseInternalDate } from "./parse.js";
import { bodyPreview, wantsLongerRead, DEEP_PREFIX_BYTES, PREFIX_BYTES } from "./snippet.js";
import { refreshAccessToken, OAuthError } from "../oauth.js";

// RFC 2177 allows 29 minutes; every server in the wild drops an IDLE that goes quiet for half an hour, and some middleboxes are stricter, so the connection is refreshed well before that.
const IDLE_RENEW_MS = 24 * 60 * 1000;
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;

function jitter(milliseconds) {
  return Math.round(milliseconds * (0.85 + Math.random() * 0.3));
}

/// The listener is REMOVED on the way out, and that is not tidiness: the signal belongs to the monitor and outlives every sleep, so a listener left behind by each backoff and each poll is a pile that only grows, on a process meant to run for months.
function sleep(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", done);
  });
}

/// The access token side of one account. Shared by every mailbox of that account, so four watched folders do not mean four refreshes.
export class AccountAuth {
  constructor({ account, state, log }) {
    this.account = account;
    this.state = state;
    this.log = log;
    this.accessToken = null;
    this.expiresAt = 0;
  }

  currentRefreshToken() {
    // The state file wins over the configuration: Microsoft rotates the refresh token at every refresh, and the one in the file is only ever the first.
    return this.state?.refreshToken(this.account.id) ?? this.account.auth.refreshToken;
  }

  async token({ force = false } = {}) {
    if (!force && this.accessToken && Date.now() < this.expiresAt) {
      return this.accessToken;
    }
    const auth = this.account.auth;
    const result = await refreshAccessToken({
      provider: auth.provider,
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      refreshToken: this.currentRefreshToken(),
      tenant: auth.tenant,
    });
    this.accessToken = result.accessToken;
    this.expiresAt = result.expiresAt.getTime();
    if (result.rotated) {
      this.log.info("the provider rotated the refresh token, storing the new one");
      this.state?.setRefreshToken(this.account.id, result.refreshToken);
    }
    return this.accessToken;
  }
}

export class MailboxMonitor {
  constructor({ account, mailbox, auth, config, state, log, notifier }) {
    this.account = account;
    this.mailbox = mailbox;
    this.auth = auth;
    this.config = config;
    this.state = state;
    this.log = log;
    this.notifier = notifier;
    this.controller = new AbortController();
    this.connection = null;
    this.backoff = BACKOFF_START_MS;
    this.stopped = false;
    this.status = { connected: false, lastEventAt: null, lastError: null, pushed: 0, givenUp: null };
  }

  get running() {
    return !this.stopped;
  }

  stop() {
    this.stopped = true;
    this.controller.abort();
    this.connection?.destroy();
  }

  async run() {
    while (this.running) {
      try {
        await this.session();
        // A session that ends by itself (server hung up, IDLE closed) is normal: reconnect promptly rather than after a backoff.
        this.backoff = BACKOFF_START_MS;
      } catch (error) {
        this.status.connected = false;
        this.status.lastError = error.message;
        if (!this.running) {
          // Stopping tears the socket down, and the command in flight fails because of that. It is not an incident and it must not be logged as one on the way out.
          return;
        }
        if (error instanceof ImapError && error.permanent) {
          this.log.error(
            "the server refused this account for good, this mailbox is given up until the watcher restarts",
            { error: error.message },
          );
          await this.giveUp("loginRefused");
          return;
        }
        if (error instanceof OAuthError && error.permanent) {
          if (error.clientRefused) {
            this.log.error("the OAuth client of this account is refused, this mailbox is given up until the watcher restarts", { error: error.message });
          } else {
            this.log.error(
              `the refresh token is dead, run "ksmail-watcher oauth --account ${this.account.id}" again`,
              { error: error.message, hint: this.deadTokenHint() },
            );
          }
          await this.giveUp("oauthExpired");
          return;
        }
        this.log.warn("session ended, reconnecting", { in: `${Math.round(this.backoff / 1000)}s`, error: error.message });
        await sleep(jitter(this.backoff), this.controller.signal);
        this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
      } finally {
        this.connection?.destroy();
        this.connection = null;
      }
      if (!this.running) {
        return;
      }
    }
  }

  /// This mailbox is done until the watcher restarts. The rest of the process is NOT: the other accounts keep watching, and the owner of this one is told on their own devices, because a watcher that goes quiet looks exactly like a week without mail.
  async giveUp(reason) {
    this.status.givenUp = reason;
    try {
      await this.notifier.notifyAccountFailure({ account: this.account, reason });
    } catch (error) {
      this.log.error("could not tell the devices about it either", { error: error.message });
    }
  }

  /// The one cause worth naming in the log, because Google's own text ("Token has been expired or revoked") does not: an OAuth client whose consent screen is still "Testing" gets refresh tokens that die after seven days, whatever the watcher does with them.
  deadTokenHint() {
    if (this.account.auth.provider !== "google") {
      return undefined;
    }
    return "a token that died about a week after \"ksmail-watcher oauth\" means the Google consent screen is still in Testing, publish it (In production)";
  }

  async session() {
    const connection = new ImapConnection({
      host: this.account.host,
      port: this.account.port,
      useTLS: this.account.tls,
      log: this.log,
    });
    this.connection = connection;

    await connection.connect();
    await connection.capability();
    await this.authenticate(connection);
    // Capabilities change after login (Gmail only advertises some of them to an authenticated session).
    await connection.capability();

    const summary = await connection.select(this.mailbox, { readOnly: true });
    this.status.connected = true;
    this.log.info("watching", {
      uidValidity: summary.uidValidity,
      uidNext: summary.uidNext,
      exists: summary.exists,
      idle: connection.supports("IDLE"),
    });

    await this.checkForNewMessages(connection, summary);

    if (!connection.supports("IDLE")) {
      await this.pollLoop(connection, summary);
      return;
    }

    while (this.running && !connection.closed) {
      const reason = await connection.idle(IDLE_RENEW_MS);
      this.status.lastEventAt = new Date();
      if (reason === "closed") {
        return;
      }
      if (reason === "update") {
        await this.checkForNewMessages(connection, summary);
      }
    }
  }

  async pollLoop(connection, summary) {
    this.log.warn("server does not advertise IDLE, falling back to polling", {
      every: `${this.config.pollSeconds}s`,
    });
    while (this.running && !connection.closed) {
      await sleep(this.config.pollSeconds * 1000, this.controller.signal);
      if (!this.running || connection.closed) {
        return;
      }
      await connection.noop();
      await this.checkForNewMessages(connection, summary);
    }
  }

  async authenticate(connection) {
    if (this.account.auth.type === "password") {
      await connection.login(this.account.username, this.account.auth.password);
      return;
    }
    try {
      await connection.authenticateXOAUTH2(this.account.username, await this.auth.token());
    } catch (error) {
      // A rejected token is usually one the provider expired early. One forced refresh, then the error stands.
      this.log.info("XOAUTH2 refused, refreshing the access token once", { error: error.message });
      await connection.authenticateXOAUTH2(this.account.username, await this.auth.token({ force: true }));
    }
  }

  /// The starting point the first time a mailbox is seen, and after a UIDVALIDITY change: the current top, so nothing already in the mailbox is announced as new.
  async establishStartingPoint(connection, summary) {
    const top = summary.uidNext && summary.uidNext > 0
      ? summary.uidNext - 1
      : await connection.highestUid();
    this.state.setMailboxState(this.account.id, this.mailbox, {
      uidValidity: summary.uidValidity,
      lastUid: top,
      updatedAt: new Date().toISOString(),
    });
    this.log.info("first sight of this mailbox, nothing before this point is news", { lastUid: top });
  }

  async checkForNewMessages(connection, summary) {
    const remembered = this.state.mailboxState(this.account.id, this.mailbox);
    if (!remembered || remembered.uidValidity !== summary.uidValidity) {
      if (remembered) {
        this.log.warn("the server renumbered this mailbox, the memory of it is dropped", {
          was: remembered.uidValidity,
          now: summary.uidValidity,
        });
      }
      await this.establishStartingPoint(connection, summary);
      return [];
    }

    const items = await connection.fetchEnvelopesFrom(remembered.lastUid + 1);
    // "n:*" answers with the last message even when its UID is below n, so the filter is not a precaution, it is the correction.
    const arrived = items
      .filter((item) => item.uid > remembered.lastUid)
      .sort((first, second) => first.uid - second.uid);

    if (arrived.length === 0) {
      return [];
    }

    const highestUid = arrived[arrived.length - 1].uid;
    const worthPushing = this.selectWorthPushing(arrived);

    await this.readPreviews(connection, worthPushing);
    for (const item of worthPushing) {
      await this.readFurther(connection, item);
      await this.push(item);
    }

    this.state.setMailboxState(this.account.id, this.mailbox, {
      uidValidity: summary.uidValidity,
      lastUid: highestUid,
      updatedAt: new Date().toISOString(),
    });
    return worthPushing;
  }

  /// How much body to fetch for the preview, and zero when none is wanted: no command is then issued for one at all, which is what makes "senderOnly" and "subject" verifiable rather than declared.
  get bodyPrefixBytes() {
    return this.config.notifications?.preview === "full" ? PREFIX_BYTES : 0;
  }

  /// The first read of the preview, for the handful of messages that are about to be pushed and for no others.
  ///
  /// This is a second command where one used to do the pair, and that is the whole point. A preview costs 32 KB of body per message; the fetch that finds what arrived answers for EVERY message above the mark, so asking for the bodies in it made the watcher hold one slice per message that arrived while it was down, to push five of them. Two thousand waiting messages were 324 MB of resident memory on a Pi that has 1 GB, and the memory never came back (docs/DESIGN.md, "Memory"). Asked for afterwards and by UID, a preview costs what is pushed and nothing more.
  ///
  /// Best effort, like the second read below: a push that says the sender and the subject beats no push at all.
  async readPreviews(connection, items) {
    if (this.bodyPrefixBytes === 0 || items.length === 0) {
      return;
    }
    try {
      const prefixes = await connection.fetchBodyPrefixes(
        items.map((item) => item.uid),
        { length: this.bodyPrefixBytes },
      );
      for (const item of items) {
        item.bodyPrefix = prefixes.get(item.uid) ?? null;
      }
    } catch (error) {
      this.log.debug("the preview read failed, the push goes out without one", {
        uids: items.map((item) => item.uid).join(","),
        error: error.message,
      });
    }
  }

  /// The second read, for the message whose first slice stopped before the rendition the reader will be shown: a newsletter whose text part alone is longer than the slice, or whose stylesheet is (snippet.js, wantsLongerRead). The same answer the app gives its own list (IMAPProvider.headersWithPreviews), one level up: what arrives at PREFIX_BYTES is not the whole message.
  ///
  /// Best effort. A server that refuses a partial read at an offset leaves the preview what the first slice gave, the courtesy line of the text part, and a push with that line still beats no push at all. No fetch is issued below the full preview level, because there is no slice to want more of.
  async readFurther(connection, item) {
    const prefix = item.bodyPrefix;
    // A slice shorter than what was asked for IS the whole body, and there is nothing after it to read.
    if (!prefix || prefix.length < PREFIX_BYTES || !wantsLongerRead(prefix)) {
      return;
    }
    try {
      const tail = await connection.fetchBodyTail(item.uid, {
        offset: prefix.length,
        length: DEEP_PREFIX_BYTES - prefix.length,
      });
      if (tail && tail.length > 0) {
        item.bodyPrefix = Buffer.concat([prefix, tail]);
      }
    } catch (error) {
      this.log.debug("the second read failed, the preview stays what the first slice gave", {
        uid: item.uid,
        error: error.message,
      });
    }
  }

  /// Of everything that arrived, what deserves a lock screen.
  selectWorthPushing(arrived) {
    const now = Date.now();
    const maxAgeMs = this.config.catchUpMaxAgeHours * 3600 * 1000;

    const candidates = arrived.filter((item) => {
      const flags = item.flags.map((flag) => flag.toLowerCase());
      if (flags.includes("\\seen")) {
        this.log.debug("already read elsewhere, not pushed", { uid: item.uid });
        return false;
      }
      if (flags.includes("\\deleted") || flags.includes("\\draft")) {
        return false;
      }
      const date = parseInternalDate(item.internalDate);
      if (maxAgeMs > 0 && date && now - date.getTime() > maxAgeMs) {
        // Filed into the mailbox by another client, not received now.
        this.log.debug("too old to be news, not pushed", { uid: item.uid });
        return false;
      }
      return true;
    });

    const limit = this.config.maxCatchUpPerMailbox;
    if (limit > 0 && candidates.length > limit) {
      const skipped = candidates.length - limit;
      this.log.warn("more mail than one screen holds, only the last ones are pushed", {
        arrived: candidates.length,
        skipped,
      });
      return candidates.slice(-limit);
    }
    return candidates;
  }

  async push(item) {
    const envelope = item.envelope ?? {};
    const message = {
      mailbox: this.mailbox,
      uid: item.uid,
      uidValidity: this.state.mailboxState(this.account.id, this.mailbox)?.uidValidity ?? null,
      messageId: envelope.messageId ?? null,
      subject: envelope.subject ?? "",
      from: envelope.from?.[0] ?? null,
      date: parseInternalDate(item.internalDate) ?? new Date(),
      // Read here and nowhere else, from the prefix that was fetched with this envelope. The bytes are dropped with this function's frame; what travels on is the cut preview.
      preview: item.bodyPrefix ? bodyPreview(item.bodyPrefix) : "",
    };
    this.status.pushed += 1;
    this.status.lastEventAt = new Date();
    await this.notifier.notifyNewMessage({ account: this.account, message });
  }
}

/// One account, its shared authentication, and one monitor per mailbox.
export class AccountMonitor {
  constructor({ account, config, state, log, notifier }) {
    this.account = account;
    this.auth = new AccountAuth({ account, state, log: log.child("oauth") });
    this.monitors = account.mailboxes.map((mailbox) => new MailboxMonitor({
      account,
      mailbox,
      auth: this.auth,
      config,
      state,
      log: log.child(mailbox),
      notifier,
    }));
  }

  start() {
    for (const monitor of this.monitors) {
      monitor.run().catch((error) => {
        monitor.log.error("monitor stopped on an unexpected error", { error: error.stack ?? error.message });
      });
    }
  }

  stop() {
    for (const monitor of this.monitors) {
      monitor.stop();
    }
  }
}
