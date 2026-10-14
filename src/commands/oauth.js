//
//  oauth.js
//  ksmail-watcher
//
//  Mints the refresh token a Gmail or Outlook account needs. The watcher never runs an interactive flow afterwards: from then on it only exchanges that refresh token for access tokens.
//
//  Two ways to name the account:
//  - --account <id>: the provider, client id, client secret and tenant are read from the account's entry in the configuration, and the token is WRITTEN to the state file, which is where the watcher looks first (monitor.js, AccountAuth.currentRefreshToken). Nothing to paste, and nothing to edit in a file Docker mounts read only; the watcher picks the token up at its next restart. This is the day-two path: the token died, the config is fine, run this again.
//  - --client-id (and friends) by hand: prints the JSON to paste into the configuration. The day-one path, before the account exists.
//
//  Two ways to run it, because the Pi usually has no browser:
//  - default: a loopback server listens on 127.0.0.1 for the redirect. Run this on the Mac, or over "ssh -L 8765:127.0.0.1:8765 pi".
//  - --manual: nothing listens. The browser lands on a page that fails to load, and the whole URL from the address bar is pasted back here. This is the one that works over a bare SSH session.
//
//  The flow is authorization code + PKCE, no client secret needed on Microsoft, one needed on Google because Google issues one even to "Desktop app" clients.
//

import crypto from "node:crypto";
import http from "node:http";
import readline from "node:readline/promises";
import { OAUTH_PROVIDERS, exchangeAuthorizationCode } from "../oauth.js";
import { loadConfig } from "../config.js";
import { State } from "../state.js";

function base64url(buffer) {
  return buffer.toString("base64url");
}

function pkce() {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function authorizationUrl({ provider, clientId, redirectUri, challenge, state, tenant, loginHint }) {
  const definition = OAUTH_PROVIDERS[provider];
  const url = new URL(definition.authorizationEndpoint(tenant));
  const parameters = {
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: definition.scopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    ...definition.extraAuthorizationParameters,
  };
  if (loginHint) {
    parameters.login_hint = loginHint;
  }
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function waitForRedirect({ port, expectedState }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><meta charset="utf-8"><title>ksMail watcher</title>` +
        `<body style="font: 16px -apple-system, system-ui; padding: 3rem">` +
        `<p>${code ? "C'est bon, vous pouvez fermer cette page." : "Echec de l'autorisation."}</p></body>`,
      );
      server.close();
      if (error) {
        reject(new Error(`the provider answered ${error}`));
      } else if (!code) {
        reject(new Error("the redirect carried no code"));
      } else if (state !== expectedState) {
        reject(new Error("the redirect carried the wrong state, someone else answered"));
      } else {
        resolve(code);
      }
    });
    server.on("error", reject);
    // 127.0.0.1 and not 0.0.0.0: the watcher never listens on the network, not even for the ten seconds this takes.
    server.listen(port, "127.0.0.1");
  });
}

async function askForRedirectUrl(expectedState) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("\nPaste the whole URL from the address bar of the page that refused to connect:\n> ");
  rl.close();
  const url = new URL(answer.trim());
  const code = url.searchParams.get("code");
  if (!code) {
    throw new Error("that URL carries no code parameter");
  }
  if (url.searchParams.get("state") !== expectedState) {
    throw new Error("that URL carries the wrong state");
  }
  return code;
}

/// What the flow needs, from the configured account when --account is given and from the flags otherwise. A flag typed next to --account wins over the file, so a rotated client secret can be tried without editing anything.
export function resolveOAuthRequest({ accountId, provider, clientId, clientSecret, tenant, address }, config) {
  if (!accountId) {
    return { provider, clientId, clientSecret, tenant, address, account: null };
  }
  const account = config.accounts.find((entry) => entry.id === accountId);
  if (!account) {
    throw new Error(`no account "${accountId}" in the configuration`);
  }
  if (account.auth.type !== "oauth") {
    throw new Error(`account "${accountId}" uses a password, there is no token to mint`);
  }
  return {
    provider: provider ?? account.auth.provider,
    clientId: clientId ?? account.auth.clientId,
    clientSecret: clientSecret ?? account.auth.clientSecret,
    tenant: tenant === "common" ? account.auth.tenant : tenant,
    address: address ?? account.address,
    account,
  };
}

export async function oauth(options) {
  const { port, manual, configPath, accountId } = options;
  const config = accountId ? loadConfig(configPath) : null;
  let request;
  try {
    request = resolveOAuthRequest(options, config);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const { provider, clientId, clientSecret, tenant, address, account } = request;
  if (!OAUTH_PROVIDERS[provider]) {
    process.stderr.write(`unknown provider ${provider} (google or microsoft)\n`);
    return 1;
  }
  if (!clientId) {
    process.stderr.write("--client-id is required\n");
    return 1;
  }

  const redirectUri = provider === "google"
    ? `http://127.0.0.1:${port}/`
    : `http://localhost:${port}/`;
  const { verifier, challenge } = pkce();
  const state = base64url(crypto.randomBytes(16));
  const url = authorizationUrl({
    provider, clientId, redirectUri, challenge, state, tenant, loginHint: address,
  });

  process.stdout.write("\nOpen this URL in a browser, on any machine:\n\n");
  process.stdout.write(`${url}\n`);
  if (manual) {
    // Said BEFORE the browser shows it, because "refused to connect" on a page one was sent to reads as a failure, and here it is the expected last step: nothing listens, the code is in the address.
    process.stdout.write(
      "\nAfter you approve, the browser will land on http://127.0.0.1:" + port + "/ and say it cannot connect.\n" +
      "That is expected: nothing listens there. The code is in the address bar. Copy the WHOLE URL\n" +
      "from the address bar (it starts with http://127.0.0.1:" + port + "/?state=...) and paste it below.\n",
    );
  } else {
    process.stdout.write(`\nWaiting for the redirect on ${redirectUri} ...\n`);
  }

  const code = manual
    ? await askForRedirectUrl(state)
    : await waitForRedirect({ port, expectedState: state });

  const tokens = await exchangeAuthorizationCode({
    provider, clientId, clientSecret, code, codeVerifier: verifier, redirectUri, tenant,
  });

  if (account) {
    // Into the state file, the place the watcher reads first, and written now rather than on exit: this is the whole point of the command. The old token in the configuration, if any, is simply never looked at again.
    const state = new State(config.stateFile, null).load();
    state.setRefreshToken(account.id, tokens.refreshToken);
    state.save();
    process.stdout.write(
      `\nDone. The new refresh token for "${account.id}" is in ${config.stateFile}; ` +
      "restart the watcher and it will use it. Nothing to edit in config.json.\n",
    );
    if (provider === "microsoft") {
      process.stdout.write(
        "Microsoft rotates this token at every refresh: keep the state file across restarts.\n",
      );
    }
    return 0;
  }

  process.stdout.write("\nDone. Put this in the accounts entry of your config.json:\n\n");
  process.stdout.write(`${JSON.stringify({
    auth: {
      type: "oauth",
      provider,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      refreshToken: tokens.refreshToken,
      ...(tenant && tenant !== "common" ? { tenant } : {}),
    },
  }, null, 2)}\n\n`);
  if (provider === "microsoft") {
    process.stdout.write(
      "Microsoft rotates this token at every refresh: the watcher stores the new one in its state file, so keep that file across restarts.\n",
    );
  }
  return 0;
}
