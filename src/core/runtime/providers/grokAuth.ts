import { createServer } from "node:http"
import { randomBytes, createHash } from "node:crypto"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { MONOLITO_ROOT } from "../../system/root.ts"

// Official Grok-CLI Client Credentials
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access"
export const XAI_OAUTH_REDIRECT_PORT = 56121
export const XAI_OAUTH_REDIRECT_URI = `http://127.0.0.1:${XAI_OAUTH_REDIRECT_PORT}/callback`
export const XAI_OAUTH_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration"

export type GrokTokens = {
  access_token: string
  refresh_token: string
  id_token?: string
  expires_at: string
  obtained_at: string
  token_type: string
}

export function getGrokTokensPath(): string {
  return join(MONOLITO_ROOT, "grok_oauth.json")
}

/**
 * Fetch token and auth endpoints from xAI OpenID Discovery.
 * Fallbacks are provided if discovery is unreachable.
 */
export async function discoverXaiEndpoints(): Promise<{ authorization_endpoint: string; token_endpoint: string }> {
  try {
    const res = await fetch(XAI_OAUTH_DISCOVERY_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    })
    if (res.ok) {
      const data = (await res.json()) as any
      if (data.authorization_endpoint && data.token_endpoint) {
        return {
          authorization_endpoint: data.authorization_endpoint,
          token_endpoint: data.token_endpoint,
        }
      }
    }
  } catch {
    // Silently fall back to standard endpoints
  }
  return {
    authorization_endpoint: "https://auth.x.ai/oauth2/auth",
    token_endpoint: "https://auth.x.ai/oauth2/token",
  }
}

/**
 * Generates PKCE code challenge and verifier
 */
export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url")
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
  return { codeVerifier, codeChallenge }
}

/**
 * Starts a local HTTP callback server to capture the authorization code.
 * Resolves with the code when successfully received.
 */
export function listenForAuthCode(
  state: string,
  timeoutMs = 180000,
): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url || "", `http://127.0.0.1:${XAI_OAUTH_REDIRECT_PORT}`)
      
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" })
        res.end("Not Found")
        return
      }

      const code = reqUrl.searchParams.get("code")
      const returnedState = reqUrl.searchParams.get("state")

      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end("<h1>Authentication Failed</h1><p>State mismatch or authorization code missing.</p>")
        return
      }

      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Monolito V2 - Authenticated</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
              background-color: #0b0f19;
              color: #f3f4f6;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
            }
            .card {
              background: rgba(255, 255, 255, 0.05);
              backdrop-filter: blur(10px);
              border: 1px solid rgba(255, 255, 255, 0.1);
              padding: 40px;
              border-radius: 16px;
              text-align: center;
              box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
              max-width: 400px;
            }
            h1 {
              color: #3b82f6;
              margin-bottom: 16px;
            }
            p {
              color: #9ca3af;
              font-size: 16px;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Success!</h1>
            <p>Monolito V2 successfully authenticated with Grok / xAI.</p>
            <p>You can close this window now and return to your terminal.</p>
          </div>
        </body>
        </html>
      `)

      resolve({ code })
      
      // Stop the server after a short delay to allow the browser to render the response
      setTimeout(() => {
        server.close()
      }, 1000)
    })

    server.listen(XAI_OAUTH_REDIRECT_PORT, "127.0.0.1", () => {
      // Server started successfully
    })

    server.on("error", (err) => {
      reject(new Error(`Failed to start loopback server on port ${XAI_OAUTH_REDIRECT_PORT}: ${err.message}`))
    })

    setTimeout(() => {
      server.close()
      reject(new Error("Authentication timeout. The flow took too long to complete."))
    }, timeoutMs)
  })
}

/**
 * Exchanges authorization code for tokens
 */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  codeChallenge: string,
): Promise<GrokTokens> {
  const { token_endpoint } = await discoverXaiEndpoints()
  
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: XAI_OAUTH_REDIRECT_URI,
    client_id: XAI_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
  })

  // Add original challenge/method if needed
  if (codeChallenge) {
    params.set("code_challenge", codeChallenge)
    params.set("code_challenge_method", "S256")
  }

  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  })

  if (!res.ok) {
    const detail = await res.text()
    if (res.status === 403) {
      throw new Error(`xAI token exchange failed (HTTP 403). OAuth accounts require specific SuperGrok entitlements: ${detail}`)
    }
    throw new Error(`xAI token exchange failed (HTTP ${res.status}): ${detail}`)
  }

  const payload = (await res.json()) as any
  if (!payload.access_token) {
    throw new Error("xAI token exchange response did not contain access_token")
  }

  const expires_in = Number(payload.expires_in || 3600)
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || "",
    id_token: payload.id_token || "",
    expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
    obtained_at: new Date().toISOString(),
    token_type: payload.token_type || "Bearer",
  }
}

/**
 * Refreshes an expired access token using the refresh token
 */
export async function refreshGrokTokens(refreshToken: string): Promise<GrokTokens> {
  if (!refreshToken) {
    throw new Error("No refresh token available to perform xAI Grok refresh.")
  }

  const { token_endpoint } = await discoverXaiEndpoints()

  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`xAI token refresh failed (HTTP ${res.status}): ${detail}`)
  }

  const payload = (await res.json()) as any
  if (!payload.access_token) {
    throw new Error("xAI token refresh response did not contain access_token")
  }

  const expires_in = Number(payload.expires_in || 3600)
  const tokens: GrokTokens = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || refreshToken,
    id_token: payload.id_token || "",
    expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
    obtained_at: new Date().toISOString(),
    token_type: payload.token_type || "Bearer",
  }

  // Save back to disk
  writeFileSync(getGrokTokensPath(), JSON.stringify(tokens, null, 2))
  return tokens
}

/**
 * Resolves a valid Grok access token. Triggers auto-refresh if the token is expired or close to it.
 */
export async function resolveGrokAccessToken(): Promise<string> {
  const path = getGrokTokensPath()
  if (!existsSync(path)) {
    throw new Error("Grok OAuth credentials not found. Please authenticate first using 'monolito auth xai-oauth'.")
  }

  let tokens: GrokTokens
  try {
    tokens = JSON.parse(readFileSync(path, "utf-8")) as GrokTokens
  } catch (err) {
    throw new Error(`Failed to parse Grok OAuth credentials: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!tokens.access_token) {
    throw new Error("Grok OAuth credentials file is invalid. Please re-authenticate.")
  }

  // Check if token expires within 2 minutes (120000ms)
  const expiresAt = Date.parse(tokens.expires_at)
  if (isNaN(expiresAt) || Date.now() + 120000 > expiresAt) {
    // Needs refresh!
    const refreshed = await refreshGrokTokens(tokens.refresh_token)
    return refreshed.access_token
  }

  return tokens.access_token
}
