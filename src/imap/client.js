//
//  client.js
//  ksmail-watcher
//
//  One connection, one mailbox, one job: stay in IDLE and say when something arrives. Commands are strictly sequential, like the Swift client, because that is what makes the untagged responses of a reply unambiguous without a full command pipeline.
//
//  The command set is deliberately tiny: CAPABILITY, LOGIN or AUTHENTICATE XOAUTH2, SELECT, UID FETCH of envelopes (and of the slice of body the preview is cut from, when one is wanted), IDLE, NOOP, LOGOUT. There is no APPEND, no STORE, no fetch of a whole body: the watcher reads the arrival of mail and never touches it.
//

import { EventEmitter } from "node:events";
import net from "node:net";
import tls from "node:tls";
import { ResponseReader, lineText } from "./reader.js";
import { parseFetch, selectSummary } from "./parse.js";
import { encodeMailboxName } from "./mailboxname.js";

export class ImapError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.permanent = permanent;
  }
}

const COMMAND_TIMEOUT_MS = 60_000;

// UIDs per body fetch. maxCatchUpPerMailbox is 5 by default, so one command does the lot; set to zero it means "no cap", and this is what keeps that configuration from rebuilding the very answer this split exists to avoid (docs/DESIGN.md, "Memory"). It also keeps the command line well under what a server will accept.
const BODY_FETCH_BATCH = 50;

export class ImapConnection extends EventEmitter {
  constructor({ host, port = 993, useTLS = true, log }) {
    super();
    this.host = host;
    this.port = port;
    this.useTLS = useTLS;
    this.log = log;
    this.socket = null;
    this.reader = new ResponseReader();
    this.tagNumber = 0;
    this.pending = null;
    this.greeting = null;
    this.capabilities = new Set();
    this.closed = false;
  }

  nextTag() {
    this.tagNumber += 1;
    return `K${this.tagNumber}`;
  }

  connect({ timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const options = { host: this.host, port: this.port, servername: this.host };
      const socket = this.useTLS ? tls.connect(options) : net.connect(options);
      this.socket = socket;
      socket.setKeepAlive(true, 60_000);

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new ImapError(`connection to ${this.host}:${this.port} timed out`));
      }, timeoutMs);

      const onReady = () => {
        // The greeting is the first logical line; connect resolves on it rather than on the socket, so a server that accepts TCP and then says BYE fails here instead of at the first command.
        this.once("greeting", (text) => {
          clearTimeout(timer);
          if (/^\* (OK|PREAUTH)/i.test(text)) {
            this.greeting = text;
            resolve(text);
          } else {
            socket.destroy();
            reject(new ImapError(`server refused the connection: ${text}`));
          }
        });
      };

      socket.on(this.useTLS ? "secureConnect" : "connect", onReady);
      socket.on("data", (chunk) => this.consume(chunk));
      socket.on("error", (error) => {
        clearTimeout(timer);
        // A DNS failure or a refused connection arrives with an empty message and only a code, and "reconnecting, error=" with nothing after it is exactly the log line nobody can act on.
        const reason = error.message || error.code || "socket error";
        this.failPending(new ImapError(reason));
        reject(new ImapError(`${this.host}: ${reason}`));
        this.handleClose();
      });
      socket.on("close", () => {
        clearTimeout(timer);
        this.handleClose();
      });
    });
  }

  handleClose() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failPending(new ImapError("connection closed"));
    this.emit("closed");
  }

  failPending(error) {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  consume(chunk) {
    this.reader.push(chunk);
    for (;;) {
      const line = this.reader.next();
      if (!line) {
        return;
      }
      this.handleLine(line);
    }
  }

  handleLine(line) {
    const text = lineText(line);
    if (!this.greeting && !this.pending) {
      this.emit("greeting", text);
      this.greeting = text;
      return;
    }

    const pending = this.pending;
    if (!pending) {
      this.emit("untagged", line, text);
      return;
    }

    if (text.startsWith("+")) {
      if (pending.onContinuation) {
        pending.onContinuation(text);
      } else {
        // Only XOAUTH2 sends an unexpected continuation, when it rejects the token: an empty line unblocks it and the NO that follows carries the reason.
        this.write("\r\n");
      }
      return;
    }

    if (text.startsWith("* ")) {
      if (pending.collectUntagged) {
        pending.untagged.push(line);
      }
      this.emit("untagged", line, text);
      if (pending.onUntagged) {
        pending.onUntagged(line, text);
      }
      return;
    }

    if (text.startsWith(`${pending.tag} `)) {
      clearTimeout(pending.timer);
      this.pending = null;
      const rest = text.slice(pending.tag.length + 1);
      if (/^OK/i.test(rest)) {
        pending.resolve({ untagged: pending.untagged, completion: rest.slice(3) });
      } else {
        // NO is a refusal of this command, BAD a protocol error. A refusal at login is permanent: retrying a wrong password every ten seconds is how an account gets locked.
        pending.reject(new ImapError(rest, { permanent: pending.permanentOnRefusal === true }));
      }
    }
  }

  write(text) {
    if (!this.socket || this.socket.destroyed) {
      throw new ImapError("connection closed");
    }
    this.socket.write(text);
  }

  /// Runs one command and collects everything up to its tagged completion.
  ///
  /// collectUntagged false keeps nothing: IDLE is a command that stays open for twenty-four minutes and whose untagged lines are read as they arrive, by onUntagged, so holding on to them until DONE is just a pile that grows with how chatty the server is.
  command(text, { timeoutMs = COMMAND_TIMEOUT_MS, onContinuation, onUntagged, permanentOnRefusal = false, redactInLog = false, collectUntagged = true } = {}) {
    if (this.pending) {
      return Promise.reject(new ImapError("a command is already running"));
    }
    const tag = this.nextTag();
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.failPending(new ImapError(`command timed out: ${redactInLog ? "(redacted)" : text}`));
            this.socket?.destroy();
          }, timeoutMs)
        : null;
      this.pending = { tag, untagged: [], collectUntagged, resolve, reject, timer, onContinuation, onUntagged, permanentOnRefusal };
      this.log?.debug("command", { tag, text: redactInLog ? "(redacted)" : text });
      try {
        this.write(`${tag} ${text}\r\n`);
      } catch (error) {
        this.failPending(error);
      }
    });
  }

  async capability() {
    const response = await this.command("CAPABILITY");
    this.capabilities = new Set();
    for (const line of response.untagged) {
      const text = lineText(line);
      if (/^\* CAPABILITY /i.test(text)) {
        for (const item of text.slice(13).trim().split(" ")) {
          this.capabilities.add(item.toUpperCase());
        }
      }
    }
    return this.capabilities;
  }

  supports(capability) {
    return this.capabilities.has(capability.toUpperCase());
  }

  static quote(value) {
    return `"${value.replace(/([\\"])/g, "\\$1")}"`;
  }

  async login(username, password) {
    await this.command(
      `LOGIN ${ImapConnection.quote(username)} ${ImapConnection.quote(password)}`,
      { permanentOnRefusal: true, redactInLog: true },
    );
  }

  /// SASL XOAUTH2 with an initial response, the way both Google and Microsoft want it.
  async authenticateXOAUTH2(username, accessToken) {
    const initial = Buffer
      .from(`user=${username}\x01auth=Bearer ${accessToken}\x01\x01`, "utf8")
      .toString("base64");
    await this.command(`AUTHENTICATE XOAUTH2 ${initial}`, {
      // A rejected token is NOT permanent: it is the signal to refresh and reconnect, which is what the monitor does.
      permanentOnRefusal: false,
      redactInLog: true,
    });
  }

  /// EXAMINE by default, and that default matters: the watcher must never mark a message read or consume \Recent.
  async select(mailbox, { readOnly = true } = {}) {
    const command = readOnly ? "EXAMINE" : "SELECT";
    const response = await this.command(
      `${command} ${ImapConnection.quote(encodeMailboxName(mailbox))}`,
    );
    return selectSummary(response.untagged, response.completion);
  }

  /// Envelopes of everything above a UID. "<uid>:*" always answers with at least the highest message even when it is below <uid>, so the caller still has to filter, and does.
  ///
  /// Headers only, and NO body: this is the command whose answer is proportional to how long the watcher was down, and a slice of body on every line of it is what fills a Raspberry Pi (docs/DESIGN.md, "Memory"). The bodies the previews are cut from are asked for afterwards, by UID, in fetchBodyPrefixes.
  async fetchEnvelopesFrom(uid) {
    const response = await this.command(
      `UID FETCH ${uid}:* (UID FLAGS INTERNALDATE ENVELOPE)`,
    );
    return response.untagged.map(parseFetch).filter((item) => item && item.uid !== null);
  }

  /// The first bytes of the body of the named messages, for the notification preview, as a Map of UID to bytes. One command for the lot at the default cap, BODY_FETCH_BATCH at a time above it.
  ///
  /// BODY.PEEK and never BODY, or the fetch would set \Seen and the watcher would be reading the reader's mail out from under them. The mailbox is opened with EXAMINE too, so this is the belt to that pair of braces. A watcher configured not to preview never calls this at all, and so never asks a server for a body (docs/PROTOCOL.md).
  async fetchBodyPrefixes(uids, { length }) {
    const prefixes = new Map();
    if (uids.length === 0 || length <= 0) {
      return prefixes;
    }
    for (let start = 0; start < uids.length; start += BODY_FETCH_BATCH) {
      const batch = uids.slice(start, start + BODY_FETCH_BATCH);
      const response = await this.command(
        `UID FETCH ${batch.join(",")} (UID BODY.PEEK[TEXT]<0.${length}>)`,
      );
      for (const line of response.untagged) {
        const item = parseFetch(line);
        if (item && item.uid !== null && item.bodyPrefix) {
          prefixes.set(item.uid, item.bodyPrefix);
        }
      }
    }
    return prefixes;
  }

  /// The slice of body AFTER the one fetchBodyPrefixes read, for one message: the second read of a preview whose first slice stopped before the rendition the reader will be shown (snippet.js, wantsLongerRead). Same BODY.PEEK, for the same reason, and the two slices are adjacent byte ranges of the same body, so glued they are exactly what one bigger read would have given. null when the server answered without one.
  async fetchBodyTail(uid, { offset, length }) {
    const response = await this.command(
      `UID FETCH ${uid} (UID BODY.PEEK[TEXT]<${offset}.${length}>)`,
    );
    const item = response.untagged
      .map(parseFetch)
      .find((candidate) => candidate && candidate.uid === uid);
    return item?.bodyPrefix ?? null;
  }

  /// Highest UID in the selected mailbox, used the first time a mailbox is seen: everything at or below it is "already there" and must never be pushed. "*:*" is the one form that answers with the last message and nothing else.
  async highestUid() {
    try {
      const response = await this.command("UID FETCH *:* (UID)");
      const uids = response.untagged
        .map(parseFetch)
        .filter((item) => item && item.uid !== null)
        .map((item) => item.uid);
      return uids.length > 0 ? Math.max(...uids) : 0;
    } catch {
      // An empty mailbox makes some servers answer BAD rather than nothing at all, and an empty mailbox has no highest UID.
      return 0;
    }
  }

  async noop() {
    await this.command("NOOP");
  }

  /// Waits inside IDLE until the server says something happened, or until maxMs elapses (the connection has to be refreshed well before the 29 minutes RFC 2177 allows, or the server drops it).
  ///
  /// Resolves with "update", "renew" or "closed".
  idle(maxMs) {
    if (!this.supports("IDLE")) {
      return Promise.reject(new ImapError("server does not advertise IDLE"));
    }
    return new Promise((resolve, reject) => {
      let finishReason = null;
      let renewTimer = null;

      const sendDone = (reason) => {
        if (finishReason) {
          return;
        }
        finishReason = reason;
        clearTimeout(renewTimer);
        try {
          this.write("DONE\r\n");
        } catch (error) {
          reject(error);
        }
      };

      this.command("IDLE", {
        timeoutMs: 0,
        collectUntagged: false,
        onContinuation: () => {
          renewTimer = setTimeout(() => sendDone("renew"), maxMs);
        },
        onUntagged: (_line, text) => {
          // EXISTS is the arrival. FETCH and EXPUNGE mean a flag moved or a message left, which the watcher does not push but which is a good moment to resynchronize its counters.
          if (/^\* \d+ (EXISTS|RECENT|FETCH|EXPUNGE)/i.test(text)) {
            sendDone("update");
          } else if (/^\* BYE/i.test(text)) {
            sendDone("closed");
          }
        },
      }).then(
        () => resolve(finishReason ?? "update"),
        (error) => reject(error),
      ).finally(() => {
        // The renew timer is 24 minutes long. A connection that dies while idling settles the command with the timer still armed, and one of those per reconnection is a slow leak that keeps the process alive on the way out.
        clearTimeout(renewTimer);
      });
    });
  }

  async logout() {
    try {
      await this.command("LOGOUT", { timeoutMs: 5_000 });
    } catch {
      // A server that hangs up before answering LOGOUT is not a problem.
    }
    this.destroy();
  }

  destroy() {
    this.socket?.destroy();
    this.socket = null;
  }
}
