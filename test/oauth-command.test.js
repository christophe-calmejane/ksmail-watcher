//
//  oauth-command.test.js
//  ksmail-watcher tests
//
//  Why this exists: "ksmail-watcher oauth --account" is the command run the day a token dies, on a Pi, over SSH, by someone who would rather not open config.json. It reads the account from the configuration and writes the token to the state file WHILE the watcher may be running and writing that same file. Both halves fail silently when wrong: a token read from the wrong place mints for the wrong client, and a token the watcher overwrites at the next mail is a fix that lasts until the next mail.
//

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOAuthRequest } from "../src/commands/oauth.js";
import { refreshAccessToken, OAuthError } from "../src/oauth.js";
import { State } from "../src/state.js";

const CONFIG = {
  accounts: [
    {
      id: "gmail", address: "moi@gmail.com",
      auth: { type: "oauth", provider: "google", clientId: "id-from-config", clientSecret: "secret-from-config", tenant: "common" },
    },
    { id: "free", address: "moi@free.fr", auth: { type: "password", password: "x" } },
  ],
};

test("--account takes the provider and the client from the configuration", () => {
  const request = resolveOAuthRequest({ accountId: "gmail", tenant: "common" }, CONFIG);
  assert.equal(request.provider, "google");
  assert.equal(request.clientId, "id-from-config");
  assert.equal(request.clientSecret, "secret-from-config");
  assert.equal(request.address, "moi@gmail.com");
  assert.equal(request.account.id, "gmail");
});

test("a flag typed next to --account wins over the configuration", () => {
  const request = resolveOAuthRequest({ accountId: "gmail", clientSecret: "rotated", tenant: "common" }, CONFIG);
  assert.equal(request.clientSecret, "rotated");
  assert.equal(request.clientId, "id-from-config");
});

test("an account that does not exist, or has no token to mint, is refused by name", () => {
  assert.throws(() => resolveOAuthRequest({ accountId: "nope", tenant: "common" }, CONFIG), /"nope"/);
  assert.throws(() => resolveOAuthRequest({ accountId: "free", tenant: "common" }, CONFIG), /password/);
});

test("without --account the flags are the request and nothing is read", () => {
  const request = resolveOAuthRequest({ provider: "microsoft", clientId: "c", tenant: "common" }, null);
  assert.equal(request.provider, "microsoft");
  assert.equal(request.account, null);
});

/// The watcher writes the whole state file at every mail. The oauth command writes a token into that file while the watcher runs. The watcher's next write must carry the token forward, not erase it.
test("a token written to the state file by another process survives the watcher's next save", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ksmail-oauth-")), "state.json");

  const watcher = new State(path, null).load();
  watcher.setMailboxState("gmail", "INBOX", { uidValidity: 1, lastUid: 10, updatedAt: "2026-09-13T08:00:00.000Z" });
  watcher.save();

  const command = new State(path, null).load();
  command.setRefreshToken("gmail", "fresh");
  command.save();

  // The watcher, still holding its in-memory state without the token, writes again because a mail arrived.
  watcher.setMailboxState("gmail", "INBOX", { uidValidity: 1, lastUid: 11, updatedAt: "2026-09-13T09:00:00.000Z" });
  watcher.save();

  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(onDisk.oauth.gmail.refreshToken, "fresh");
  assert.equal(onDisk.mailboxes["gmail INBOX"].lastUid, 11);
  // And the running watcher uses it from now on, without a restart being strictly necessary for the token itself.
  assert.equal(watcher.refreshToken("gmail"), "fresh");
});

/// The other direction: what the watcher itself just rotated (Microsoft) must not be undone by an older token still on disk.
test("a rotated token in memory is not replaced by an older one on disk", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ksmail-oauth-")), "state.json");
  const older = new State(path, null).load();
  older.data.oauth.outlook = { refreshToken: "old", updatedAt: "2026-09-13T08:00:00.000Z" };
  older.save();

  const watcher = new State(path, null).load();
  watcher.setRefreshToken("outlook", "rotated");
  watcher.save();
  assert.equal(JSON.parse(readFileSync(path, "utf8")).oauth.outlook.refreshToken, "rotated");
});

/// A client deleted in its console (the watcher's Desktop client taken out of a project, for instance) is not a dead token: consenting again with it fails the same way, and retrying it every few minutes helps nobody.
test("a refused OAuth client is permanent, and says the client is the problem, not the token", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: "deleted_client", error_description: "The OAuth client was deleted." }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
  try {
    await assert.rejects(
      refreshAccessToken({ provider: "google", clientId: "c", clientSecret: "s", refreshToken: "r" }),
      (error) => {
        assert.ok(error instanceof OAuthError);
        assert.equal(error.permanent, true);
        assert.equal(error.clientRefused, true);
        assert.match(error.message, /^deleted_client: The OAuth client was deleted\./);
        assert.match(error.message, /not its token/);
        assert.match(error.message, /app password/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
