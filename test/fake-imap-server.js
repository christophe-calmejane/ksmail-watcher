//
//  fake-imap-server.js
//  ksmail-watcher tests
//
//  Just enough IMAP to answer the watcher: the seven commands it sends, IDLE included, and a deliver() that pushes an untagged EXISTS at whoever is idling. Subjects always go out as a byte LITERAL, which is what a real server does for anything non ASCII and what the reader has to survive.
//
//  Plaintext, on 127.0.0.1, for the tests only.
//

import net from "node:net";

function envelopeLine(sequence, message, { partial = null } = {}) {
  const subject = Buffer.from(message.subject ?? "", "utf8");
  const from = message.from
    ? `((${message.from.name ? `"${message.from.name}"` : "NIL"} NIL "${message.from.address.split("@")[0]}" "${message.from.address.split("@")[1]}"))`
    : "NIL";
  const head = `* ${sequence} FETCH (UID ${message.uid} FLAGS (${(message.flags ?? []).join(" ")})` +
    ` INTERNALDATE "${message.internalDate}" ENVELOPE ("${message.date ?? "Sat, 5 Sep 2026 12:00:00 +0200"}" {${subject.length}}\r\n`;
  const tail = ` ${from} NIL NIL ((NIL NIL "moi" "kikisoft.fr")) NIL NIL NIL "${message.messageId ?? `<${message.uid}@fake>`}")`;
  const parts = [Buffer.from(head, "utf8"), subject, Buffer.from(tail, "utf8")];
  if (partial) {
    parts.push(...bodySlice(message, partial));
  }
  parts.push(Buffer.from(")\r\n", "utf8"));
  return Buffer.concat(parts);
}

/// The answer to a FETCH that asks for a slice of body and nothing else, which is the watcher's second read.
function bodyLine(sequence, message, partial) {
  return Buffer.concat([
    Buffer.from(`* ${sequence} FETCH (UID ${message.uid}`, "utf8"),
    ...bodySlice(message, partial),
    Buffer.from(")\r\n", "utf8"),
  ]);
}

/// A slice of the body, answered as a LITERAL and with the partial origin echoed back, which is what the servers in the wild do. Past the end of the body, the slice is what is left, possibly nothing.
function bodySlice(message, { offset, length }) {
  const body = Buffer.from(message.body ?? "", "utf8").subarray(offset, offset + length);
  return [Buffer.from(` BODY[TEXT]<${offset}> {${body.length}}\r\n`, "utf8"), body];
}

export class FakeImapServer {
  constructor({ messages = [], username = "user", password = "secret", accessToken = null, capabilities = ["IMAP4rev1", "IDLE", "AUTH=XOAUTH2"], uidValidity = 42 } = {}) {
    this.messages = [...messages];
    this.username = username;
    this.password = password;
    this.accessToken = accessToken;
    this.capabilities = capabilities;
    this.uidValidity = uidValidity;
    this.sockets = new Set();
    this.idling = new Set();
    this.commandLog = [];
    this.server = net.createServer((socket) => this.handle(socket));
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return this.server.address().port;
  }

  async stop() {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => this.server.close(resolve));
  }

  /// Appends a message and tells everyone who is idling.
  deliver(message) {
    this.messages.push(message);
    for (const socket of this.idling) {
      socket.write(`* ${this.messages.length} EXISTS\r\n`);
    }
  }

  handle(socket) {
    this.sockets.add(socket);
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.idling.delete(socket);
    });
    socket.on("error", () => {});
    socket.write("* OK fake IMAP ready\r\n");

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) {
          return;
        }
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        this.command(socket, line);
      }
    });
  }

  command(socket, line) {
    this.commandLog.push(line);
    if (line === "DONE") {
      const tag = this.idleTag ?? "*";
      this.idling.delete(socket);
      socket.write(`${tag} OK IDLE terminated\r\n`);
      return;
    }

    const space = line.indexOf(" ");
    const tag = line.slice(0, space);
    const rest = line.slice(space + 1);
    const verb = rest.split(" ")[0].toUpperCase();

    switch (verb) {
      case "CAPABILITY":
        socket.write(`* CAPABILITY ${this.capabilities.join(" ")}\r\n${tag} OK CAPABILITY done\r\n`);
        return;
      case "LOGIN": {
        const match = /^LOGIN "?([^" ]+)"? "?(.*?)"?$/.exec(rest);
        const good = match && match[1] === this.username && match[2] === this.password;
        socket.write(good ? `${tag} OK LOGIN done\r\n` : `${tag} NO wrong password\r\n`);
        return;
      }
      case "AUTHENTICATE": {
        const initial = rest.split(" ")[2] ?? "";
        const decoded = Buffer.from(initial, "base64").toString("utf8");
        const good = this.accessToken && decoded.includes(`auth=Bearer ${this.accessToken}`);
        socket.write(good ? `${tag} OK AUTH done\r\n` : `+ eyJzdGF0dXMiOiI0MDEifQ==\r\n${tag} NO invalid token\r\n`);
        return;
      }
      case "EXAMINE":
      case "SELECT": {
        const uidNext = this.messages.reduce((top, message) => Math.max(top, message.uid), 0) + 1;
        socket.write(
          `* ${this.messages.length} EXISTS\r\n` +
          `* OK [UIDVALIDITY ${this.uidValidity}] uidvalidity\r\n` +
          `* OK [UIDNEXT ${uidNext}] predicted\r\n` +
          `* OK [PERMANENTFLAGS (\\Seen \\Deleted \\*)] limited\r\n` +
          `${tag} OK [READ-ONLY] EXAMINE done\r\n`,
        );
        return;
      }
      case "UID": {
        const fetch = /^UID FETCH (\S+) \((.*)\)$/i.exec(rest);
        if (!fetch) {
          socket.write(`${tag} BAD unsupported\r\n`);
          return;
        }
        const range = fetch[1];
        let selected;
        if (range === "*:*") {
          selected = this.messages.slice(-1);
        } else if (range.includes(":")) {
          const from = Number(range.split(":")[0]);
          selected = this.messages.filter((message) => message.uid >= from);
          if (selected.length === 0 && this.messages.length > 0) {
            // What a real server does with "n:*" when n is above the top: it still answers with the last message.
            selected = this.messages.slice(-1);
          }
        } else {
          // A plain sequence set: one UID, or the comma separated list the watcher sends to read the previews of a burst.
          const wanted = new Set(range.split(",").map(Number));
          selected = this.messages.filter((message) => wanted.has(message.uid));
        }
        const items = fetch[2].toUpperCase();
        const match = /BODY\.PEEK\[TEXT\]<(\d+)\.(\d+)>/i.exec(fetch[2]);
        const partial = match ? { offset: Number(match[1]), length: Number(match[2]) } : null;
        for (const message of selected) {
          const sequence = this.messages.indexOf(message) + 1;
          if (items === "UID") {
            socket.write(`* ${sequence} FETCH (UID ${message.uid})\r\n`);
          } else if (items.includes("ENVELOPE")) {
            socket.write(envelopeLine(sequence, message, { partial }));
          } else if (partial) {
            socket.write(bodyLine(sequence, message, partial));
          }
        }
        socket.write(`${tag} OK FETCH done\r\n`);
        return;
      }
      case "IDLE":
        this.idleTag = tag;
        this.idling.add(socket);
        socket.write("+ idling\r\n");
        return;
      case "NOOP":
        socket.write(`${tag} OK NOOP done\r\n`);
        return;
      case "LOGOUT":
        socket.write(`* BYE bye\r\n${tag} OK LOGOUT done\r\n`);
        socket.end();
        return;
      default:
        socket.write(`${tag} BAD unknown command\r\n`);
    }
  }
}
