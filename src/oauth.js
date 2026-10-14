//
//  oauth.js
//  ksmail-watcher
//
//  Turns the refresh token kept in the configuration into the access token XOAUTH2 needs. No SDK, same reasoning as the app: both providers speak plain OAuth 2.0 over one POST.
//
//  Two provider facts that cost a night each if they are learned the hard way:
//
//  1. Microsoft ROTATES the refresh token: every refresh answers with a new one and the old one dies. Whoever calls this must persist what comes back (the monitor does, through the state file), or the watcher works until the first restart after ninety days and then never again.
//  2. A Google client left in "Testing" on the consent screen issues refresh tokens that expire after SEVEN days. The project has to be published (In production) for a watcher that keeps running.
//

export class OAuthError extends Error {
  constructor(message, { permanent = false, clientRefused = false } = {}) {
    super(message);
    this.permanent = permanent;
    this.clientRefused = clientRefused;
  }
}

/// The answers that refuse the OAuth client itself, whatever the token: deleted in its console, its secret wrong or reset, or not allowed this grant.
/// Consenting again with the same client changes nothing, so the message says what does.
const CLIENT_ERRORS = ["invalid_client", "deleted_client", "unauthorized_client"];

export const OAUTH_PROVIDERS = {
  google: {
    tokenEndpoint: () => "https://oauth2.googleapis.com/token",
    // Same scope as the app: full IMAP/SMTP access to the mailbox and nothing else. Calendar, contacts and tasks never appear here.
    scopes: ["https://mail.google.com/"],
    authorizationEndpoint: () => "https://accounts.google.com/o/oauth2/v2/auth",
    extraAuthorizationParameters: { access_type: "offline", prompt: "consent" },
  },
  microsoft: {
    tokenEndpoint: (tenant = "common") =>
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    scopes: ["https://outlook.office.com/IMAP.AccessAsUser.All", "offline_access"],
    authorizationEndpoint: (tenant = "common") =>
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    extraAuthorizationParameters: {},
  },
};

async function postForm(url, parameters) {
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters).toString(),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { error: "invalid_response", error_description: text.slice(0, 200) };
  }
  if (!response.ok) {
    // invalid_grant is the answer to a token that was revoked, expired or already rotated away: no amount of retrying fixes it, the owner has to consent again.
    const clientRefused = CLIENT_ERRORS.includes(payload.error);
    const permanent = payload.error === "invalid_grant" || clientRefused;
    let message = `${payload.error ?? response.status}: ${payload.error_description ?? "no description"}`;
    if (clientRefused) {
      message += " The provider refuses the OAuth client of this account (auth.clientId and auth.clientSecret), not its token: " +
        "create a new client as the README says (\"Gmail and Outlook (OAuth)\"), put it in auth and run \"ksmail-watcher oauth --account <id>\" again, " +
        "or, for Gmail, sign in with an app password instead.";
    }
    throw new OAuthError(message, { permanent, clientRefused });
  }
  return payload;
}

/// Exchanges a refresh token for an access token. Returns the access token, when it expires, and the refresh token to store from now on (unchanged on Google, new on Microsoft).
export async function refreshAccessToken({ provider, clientId, clientSecret, refreshToken, tenant }) {
  const definition = OAUTH_PROVIDERS[provider];
  if (!definition) {
    throw new OAuthError(`unknown OAuth provider ${provider}`, { permanent: true });
  }
  const parameters = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  };
  if (clientSecret) {
    parameters.client_secret = clientSecret;
  }
  if (provider === "microsoft") {
    parameters.scope = definition.scopes.join(" ");
  }

  const payload = await postForm(definition.tokenEndpoint(tenant), parameters);
  if (!payload.access_token) {
    throw new OAuthError("token endpoint answered without an access_token");
  }
  return {
    accessToken: payload.access_token,
    expiresAt: new Date(Date.now() + (Number(payload.expires_in ?? 3600) - 60) * 1000),
    refreshToken: payload.refresh_token ?? refreshToken,
    rotated: Boolean(payload.refresh_token && payload.refresh_token !== refreshToken),
  };
}

/// Authorization code exchange, used once by the "oauth" command to mint the refresh token that goes into the configuration.
export async function exchangeAuthorizationCode({
  provider, clientId, clientSecret, code, codeVerifier, redirectUri, tenant,
}) {
  const definition = OAUTH_PROVIDERS[provider];
  if (!definition) {
    throw new OAuthError(`unknown OAuth provider ${provider}`, { permanent: true });
  }
  const parameters = {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  };
  if (clientSecret) {
    parameters.client_secret = clientSecret;
  }
  const payload = await postForm(definition.tokenEndpoint(tenant), parameters);
  if (!payload.refresh_token) {
    throw new OAuthError(
      "the provider answered without a refresh_token (Google needs access_type=offline and prompt=consent, Microsoft needs the offline_access scope)",
    );
  }
  return { refreshToken: payload.refresh_token, accessToken: payload.access_token };
}
