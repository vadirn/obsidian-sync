// Minimal single-user OAuth 2.1 authorization server for the consult MCP endpoint.
// claude.ai's custom-connector flow drives OAuth discovery + DCR + PKCE and will
// not accept a static bearer, so we self-host a small AS via the SDK's
// mcpAuthRouter. The only human-in-the-loop step is /authorize, which is gated by
// HTTP Basic against MCP_AUTH_PASSWORD; every other endpoint is machine-to-machine
// and protected by PKCE / client auth handled inside the SDK handlers.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Request, Response, NextFunction } from "express";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const RESOURCE = process.env.MCP_RESOURCE_URL ?? "https://localhost/mcp";
const STORE_PATH = process.env.OAUTH_STORE ?? "/data/oauth.json";
const STATIC_TOKEN = process.env.MCP_BEARER_TOKEN ?? "";
const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL = 30 * 24 * 60 * 60; // 30 days
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const nowSec = (): number => Math.floor(Date.now() / 1000);

// --- persisted state (clients + live tokens survive restarts; codes do not) ---
type TokenRecord = { clientId: string; scopes: string[]; expiresAt: number; resource?: string };
type Store = {
  clients: Record<string, OAuthClientInformationFull>;
  access: Record<string, TokenRecord>;
  refresh: Record<string, TokenRecord>;
};

function loadStore(): Store {
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf8")) as Store;
  } catch {
    return { clients: {}, access: {}, refresh: {} };
  }
}

const store = loadStore();

function saveStore(): void {
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    const tmp = `${STORE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    renameSync(tmp, STORE_PATH); // atomic replace
  } catch (e) {
    console.error(`oauth: could not persist store (${STORE_PATH}): ${(e as Error).message}`);
  }
}

// Short-lived authorization codes, in-memory only.
type CodeRecord = {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
  scopes: string[];
  expiresAt: number;
};
const codes = new Map<string, CodeRecord>();

function issueToken(bucket: "access" | "refresh", rec: Omit<TokenRecord, "expiresAt">): string {
  const token = randomBytes(32).toString("hex");
  const ttl = bucket === "access" ? ACCESS_TTL : REFRESH_TTL;
  store[bucket][token] = { ...rec, expiresAt: nowSec() + ttl };
  return token;
}

function mintTokens(rec: Omit<TokenRecord, "expiresAt">): OAuthTokens {
  const access = issueToken("access", rec);
  const refresh = issueToken("refresh", rec);
  saveStore();
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_token: refresh,
    scope: rec.scopes.join(" ") || undefined,
  };
}

const clientsStore: OAuthRegisteredClientsStore = {
  getClient(clientId) {
    return store.clients[clientId];
  },
  registerClient(client) {
    const full = client as OAuthClientInformationFull;
    store.clients[full.client_id] = full;
    saveStore();
    return full;
  },
};

export const oauthProvider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    // The Basic-auth gate on /authorize has already authenticated the user, so a
    // valid request here is consent: mint a code bound to this client + PKCE.
    const code = randomBytes(24).toString("hex");
    codes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource: params.resource?.href,
      scopes: params.scopes ?? [],
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state) target.searchParams.set("state", params.state);
    res.redirect(302, target.href);
  },

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ) {
    const rec = codes.get(authorizationCode);
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt < Date.now()) {
      throw new InvalidTokenError("invalid or expired authorization code");
    }
    return rec.codeChallenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string, // PKCE already verified by the SDK token handler
    redirectUri?: string,
    resource?: URL,
  ) {
    const rec = codes.get(authorizationCode);
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt < Date.now()) {
      throw new InvalidTokenError("invalid or expired authorization code");
    }
    if (redirectUri && redirectUri !== rec.redirectUri) {
      throw new InvalidTokenError("redirect_uri mismatch");
    }
    if (resource && rec.resource && resource.href !== rec.resource) {
      throw new InvalidTokenError("resource mismatch");
    }
    codes.delete(authorizationCode); // single use
    return mintTokens({ clientId: client.client_id, scopes: rec.scopes, resource: RESOURCE });
  },

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    _resource?: URL,
  ) {
    const rec = store.refresh[refreshToken];
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt < nowSec()) {
      throw new InvalidTokenError("invalid or expired refresh token");
    }
    const grant = scopes && scopes.length > 0 ? scopes : rec.scopes;
    return mintTokens({ clientId: client.client_id, scopes: grant, resource: RESOURCE });
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Static token escape hatch: keeps the SDK test client and any header-based
    // client working alongside OAuth.
    if (STATIC_TOKEN && token === STATIC_TOKEN) {
      return {
        token,
        clientId: "static",
        scopes: [],
        expiresAt: nowSec() + ACCESS_TTL,
        resource: new URL(RESOURCE),
      };
    }
    const rec = store.access[token];
    if (!rec) throw new InvalidTokenError("unknown access token");
    if (rec.expiresAt < nowSec()) {
      delete store.access[token];
      saveStore();
      throw new InvalidTokenError("access token expired");
    }
    if (rec.resource && rec.resource !== RESOURCE) {
      throw new InvalidTokenError("token audience mismatch");
    }
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: rec.expiresAt,
      resource: new URL(RESOURCE),
    };
  },

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    const t = request.token;
    if (store.access[t]) delete store.access[t];
    if (store.refresh[t]) delete store.refresh[t];
    saveStore();
  },
};

/**
 * HTTP Basic gate for the /authorize endpoint: the one human-in-the-loop step.
 * Any username is accepted; the password is compared (constant time) against
 * MCP_AUTH_PASSWORD. Mount this before mcpAuthRouter so it runs ahead of the
 * SDK's authorize handler.
 */
export function basicAuthGate(req: Request, res: Response, next: NextFunction): void {
  const password = process.env.MCP_AUTH_PASSWORD ?? "";
  const challenge = (): void => {
    res
      .set("WWW-Authenticate", 'Basic realm="consult vault", charset="UTF-8"')
      .status(401)
      .send("Authentication required");
  };

  const hdr = req.header("authorization") ?? "";
  if (!hdr.startsWith("Basic ")) return challenge();
  let decoded = "";
  try {
    decoded = Buffer.from(hdr.slice(6), "base64").toString("utf8");
  } catch {
    return challenge();
  }
  const supplied = decoded.slice(decoded.indexOf(":") + 1);

  const a = Buffer.from(supplied);
  const b = Buffer.from(password);
  if (password.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) {
    return challenge();
  }
  next();
}
