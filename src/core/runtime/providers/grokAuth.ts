import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { parse as parseUrl } from "node:url";

import { MONOLITO_ROOT } from "../../system/root.ts";

// =============================================================================
// Constants
// =============================================================================
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_OAUTH_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_OAUTH_AUTHORIZE_URL = "https://auth.x.ai/oauth2/authorize";
export const XAI_OAUTH_REDIRECT_PORT = 56121;
export const XAI_OAUTH_REDIRECT_PATH = "/callback";

export interface GrokTokens {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_at: number; // Epoch seconds
}

// =============================================================================
// Storage Functions
// =============================================================================
export function getGrokTokenPath(): string {
  return join(MONOLITO_ROOT, "grok_oauth.json");
}

export async function loadGrokTokens(): Promise<GrokTokens | null> {
  const path = getGrokTokenPath();
  if (!existsSync(path)) return null;
  try {
    const data = await fs.readFile(path, "utf-8");
    return JSON.parse(data) as GrokTokens;
  } catch {
    return null;
  }
}

export async function saveGrokTokens(tokens: GrokTokens): Promise<void> {
  const path = getGrokTokenPath();
  const dir = MONOLITO_ROOT;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path, JSON.stringify(tokens, null, 2), "utf-8");
}

export async function deleteGrokTokens(): Promise<void> {
  const path = getGrokTokenPath();
  if (existsSync(path)) {
    await fs.unlink(path);
  }
}

// =============================================================================
// Cryptographic / PKCE Generators
// =============================================================================
export function generatePKCE() {
  const code_verifier = randomBytes(32)
    .toString("base64url");
  const code_challenge = createHash("sha256")
    .update(code_verifier)
    .digest("base64url");
  const state = randomBytes(16).toString("hex");
  const nonce = randomBytes(16).toString("hex");

  return { code_verifier, code_challenge, state, nonce };
}

// =============================================================================
// Token Operations (Exchange and Dynamic Refresh)
// =============================================================================
export async function exchangeCodeForTokens(
  code: string,
  code_verifier: string,
  code_challenge: string,
  redirect_uri: string
): Promise<GrokTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri,
    client_id: XAI_OAUTH_CLIENT_ID,
    code_verifier,
    code_challenge,
    code_challenge_method: "S256",
  });

  const response = await fetch(XAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 403) {
      throw new Error(
        `xAI token exchange failed (HTTP 403): ${errorText.trim()}. ` +
        "This OAuth account is not authorized for xAI API access — xAI may be restricting API/OAuth use to specific SuperGrok tiers despite the in-app subscription being active."
      );
    }
    throw new Error(`Grok token exchange failed (HTTP ${response.status}): ${errorText.trim()}`);
  }

  const payload = await response.json() as { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number };
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: payload.access_token ?? "",
    refresh_token: payload.refresh_token ?? "",
    id_token: payload.id_token,
    expires_at: now + (payload.expires_in || 3600),
  };
}

export async function refreshGrokAccessToken(tokens: GrokTokens): Promise<string> {
  if (!tokens.refresh_token) {
    throw new Error("No refresh token available in Grok credentials. Please log in again using '/model login xai-oauth'.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: XAI_OAUTH_CLIENT_ID,
  });

  const response = await fetch(XAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh Grok access token (HTTP ${response.status}): ${errorText.trim()}`);
  }

  const payload = await response.json() as { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number };
  const now = Math.floor(Date.now() / 1000);
  const nextTokens: GrokTokens = {
    access_token: payload.access_token ?? tokens.access_token,
    refresh_token: payload.refresh_token || tokens.refresh_token,
    id_token: payload.id_token || tokens.id_token,
    expires_at: now + (payload.expires_in || 3600),
  };

  await saveGrokTokens(nextTokens);
  return nextTokens.access_token;
}

export async function resolveGrokAccessToken(): Promise<string> {
  const tokens = await loadGrokTokens();
  if (!tokens) {
    throw new Error("No xAI Grok credentials found. Run 'monolito auth xai-oauth' or use '/model' in the TUI client to log in.");
  }

  const now = Math.floor(Date.now() / 1000);
  // Refresh if expired or expiring within 2 minutes (120 seconds)
  if (tokens.expires_at - now < 120) {
    return await refreshGrokAccessToken(tokens);
  }

  return tokens.access_token;
}

// =============================================================================
// Loopback Local Server Listener
// =============================================================================
export function startOAuthListener(
  port: number,
  expectedPath: string,
  onCallback: (code: string | null, state: string | null, error: string | null) => void
) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Enable CORS to allow redirects and browser pre-flights from accounts.x.ai
    const origin = req.headers.origin || "";
    if (origin === "https://accounts.x.ai" || origin === "https://auth.x.ai") {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.setHeader("Vary", "Origin");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsed = parseUrl(req.url || "", true);
    if (parsed.pathname !== expectedPath) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found.");
      return;
    }

    const code = (parsed.query.code as string) || null;
    const state = (parsed.query.state as string) || null;
    const error = (parsed.query.error as string) || null;

    if (!code && !error) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background-color: #121212; color: #e0e0e0;">
            <h1 style="color: #ff9800;">xAI authorization not received.</h1>
            <p>No authorization code was present in this callback URL.</p>
            <p>Please return to the terminal and restart the login flow.</p>
          </body>
        </html>
      `);
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (error) {
      res.end(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background-color: #121212; color: #e0e0e0;">
            <h1 style="color: #f44336;">xAI authorization failed.</h1>
            <p>The authorization server returned an error: <strong>${error}</strong></p>
            <p>You can close this tab and return to the terminal.</p>
          </body>
        </html>
      `);
    } else {
      res.end(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background-color: #121212; color: #e0e0e0;">
            <h1 style="color: #4caf50;">xAI authorization received successfully.</h1>
            <p>Credentials received! You can close this tab now and return to the terminal to continue.</p>
          </body>
        </html>
      `);
    }

    onCallback(code, state, error);
  });

  server.listen(port, "127.0.0.1");

  return server;
}
