//
//  fake-broker-server.js
//  ksmail-watcher tests
//
//  A plain HTTP server that records what the watcher asks the broker and answers what the test tells it to. The real broker is tested where it lives, with the ksMail app; what matters here is the request the watcher sends: which secret, which payload, which delivery fields.
//

import http from "node:http";

export class FakeBrokerServer {
  constructor() {
    this.requests = [];
    // Answers, in order, for the /notify requests to come. Anything past the end of the list gets a 200.
    this.answers = [];
    this.server = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (request.method === "GET" && request.url === "/health") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true, service: "ksmail-broker", version: "1" }));
          return;
        }
        const body = text ? JSON.parse(text) : null;
        this.requests.push({ method: request.method, path: request.url, body });
        const answer = this.answers.shift() ?? { status: 200, body: { ok: true, apnsId: "0000" } };
        response.writeHead(answer.status, {
          "content-type": "application/json",
          ...(answer.headers ?? {}),
        });
        response.end(JSON.stringify(answer.body ?? {}));
      });
    });
  }

  /// The notifications only, which is what most tests count.
  get notifications() {
    return this.requests.filter((request) => request.path === "/notify");
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${this.server.address().port}`;
  }

  async stop() {
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
