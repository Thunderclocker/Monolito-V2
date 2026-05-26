import * as os from "node:os";
import { spawn } from "node:child_process";
import * as readline from "node:readline/promises";
import {
  generatePKCE,
  exchangeCodeForTokens,
  saveGrokTokens,
  startOAuthListener,
  XAI_OAUTH_AUTHORIZE_URL,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_SCOPE,
  XAI_OAUTH_REDIRECT_PORT,
  XAI_OAUTH_REDIRECT_PATH
} from "../../core/runtime/providers/grokAuth.ts";

function isRemoteSession(): boolean {
  return !!(
    process.env.SSH_CLIENT ||
    process.env.SSH_TTY ||
    process.env.SSH_CONNECTION ||
    process.env.SSH_TUNNEL ||
    process.env.REMOTE_CONTAINERS ||
    process.env.CODESPACES
  );
}

function getSshUserAtHost(): string {
  const user = process.env.USER || process.env.LOGNAME || "user";
  let host = os.hostname() || "vps";
  if (host === "localhost" || host === "127.0.0.1") {
    host = "vps";
  }
  return `${user}@${host}`;
}

function openBrowser(url: string) {
  try {
    if (process.platform === "linux") {
      spawn("xdg-open", [url], { stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore" }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", url], { stdio: "ignore" }).unref();
    }
  } catch {
    // Fail silently if browser cannot be opened
  }
}

export async function runGrokOAuthLogin(noBrowser: boolean, manualPaste: boolean): Promise<void> {
  const { code_verifier, code_challenge, state, nonce } = generatePKCE();
  const redirectUri = `http://127.0.0.1:${XAI_OAUTH_REDIRECT_PORT}${XAI_OAUTH_REDIRECT_PATH}`;
  const authUrl = `${XAI_OAUTH_AUTHORIZE_URL}?response_type=code&client_id=${XAI_OAUTH_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(XAI_OAUTH_SCOPE)}&code_challenge=${code_challenge}&code_challenge_method=S256&state=${state}&nonce=${nonce}&plan=generic&referrer=hermes-agent`;

  console.log("\n============================================================");
  console.log("    Inicio de Sesión en xAI Grok (SuperGrok / Premium+)");
  console.log("============================================================\n");

  console.log("Abre este enlace en tu navegador web para autorizar a Monolito:");
  console.log("\x1b[36m" + authUrl + "\x1b[0m\n");

  if (manualPaste) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log("Iniciando en modo de PEGA MANUAL (sin levantar puertos locales).");
      console.log("Completa la autenticación en tu navegador.");
      console.log("Cuando intente redirigir y falle, copia el código ('code=...') o la URL de callback completa.");
      console.log();
      const inputRaw = await rl.question("Pega la URL de callback completa o el código de autorización ('code'): ");
      console.log();

      const cleanedInput = inputRaw.trim();
      let incomingCode: string | null = null;
      let incomingState: string | null = null;
      let incomingError: string | null = null;

      if (cleanedInput.startsWith("http://") || cleanedInput.startsWith("https://")) {
        try {
          const urlObj = new URL(cleanedInput);
          incomingCode = urlObj.searchParams.get("code");
          incomingState = urlObj.searchParams.get("state");
          incomingError = urlObj.searchParams.get("error");
        } catch (err) {
          throw new Error(`Error al analizar la URL: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        // Treat as raw authorization code
        incomingCode = cleanedInput;
        incomingState = state; // bypass state check by matching current state
      }

      if (incomingError) {
        throw new Error(`El servidor OAuth devolvió un error: ${incomingError}`);
      }
      if (incomingState !== state) {
        throw new Error("Mismatched OAuth state parameter (posible CSRF)");
      }
      if (!incomingCode) {
        throw new Error("No se pudo extraer el código de autorización de la entrada provista.");
      }

      console.log("Intercambiando código de autorización por tokens...");
      const tokens = await exchangeCodeForTokens(incomingCode, code_verifier, code_challenge, redirectUri);
      await saveGrokTokens(tokens);
      console.log("\x1b[32m✔ ¡Autenticación exitosa! Tokens guardados en ~/.monolito-v2/grok_oauth.json\x1b[0m\n");
    } finally {
      rl.close();
    }
    return;
  }

  // Active loopback listener flow
  const remote = isRemoteSession();
  if (remote) {
    console.log("-".repeat(60));
    console.log(" Sesión remota (SSH/VPS) detectada — Se requiere túnel");
    console.log("-".repeat(60));
    console.log("Monolito está esperando el callback en su puerto local.");
    console.log("Ejecuta este comando en una NUEVA terminal en tu máquina local:");
    console.log();
    console.log(`  \x1b[33mssh -N -L ${XAI_OAUTH_REDIRECT_PORT}:127.0.0.1:${XAI_OAUTH_REDIRECT_PORT} ${getSshUserAtHost()}\x1b[0m`);
    console.log();
    console.log("Luego abre el enlace de arriba en tu navegador local.");
    console.log("Si no puedes abrir puertos, vuelve a correr el comando con --manual-paste.");
    console.log("-".repeat(60) + "\n");
  } else if (!noBrowser) {
    console.log("Intentando abrir el navegador automáticamente...\n");
    openBrowser(authUrl);
  }

  console.log(`Waiting for authorization callback on ${redirectUri}...`);
  console.log("(Presiona Ctrl+C para cancelar)\n");

  let resolved = false;

  await new Promise<void>((resolve, reject) => {
    const server = startOAuthListener(XAI_OAUTH_REDIRECT_PORT, XAI_OAUTH_REDIRECT_PATH, async (code, incomingState, error) => {
      if (resolved) return;
      resolved = true;
      server.close();

      if (error) {
        reject(new Error(`El servidor OAuth devolvió un error: ${error}`));
        return;
      }
      if (incomingState !== state) {
        reject(new Error("Mismatched OAuth state parameter (posible CSRF)"));
        return;
      }
      if (!code) {
        reject(new Error("No se recibió código de autorización"));
        return;
      }

      try {
        console.log("Intercambiando código de autorización por tokens...");
        const tokens = await exchangeCodeForTokens(code, code_verifier, code_challenge, redirectUri);
        await saveGrokTokens(tokens);
        console.log("\x1b[32m✔ ¡Autenticación exitosa! Tokens guardados en ~/.monolito-v2/grok_oauth.json\x1b[0m\n");
        resolve();
      } catch (err) {
        reject(err);
      }
    });

    // Handle process interruption to close server gracefully
    const onSigInt = () => {
      if (resolved) return;
      resolved = true;
      server.close();
      reject(new Error("Autenticación cancelada por el usuario."));
    };
    process.once("SIGINT", onSigInt);

    // Auto-timeout after 3 minutes (180 seconds)
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      server.close();
      process.off("SIGINT", onSigInt);
      reject(new Error("La autorización expiró (timeout de 3 minutos) esperando la redirección local."));
    }, 180_000);
  });
}
