import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  lstatSync,
} from "node:fs";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { parse } from "jsonc-parser";
import { setTimeout as sleep } from "node:timers/promises";
export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const DEMO_TOKEN = "hej-hej-offline-demo-admin-not-for-deployment";
export const SECRET_KEYS = new Set([
  "ADMIN_TOKEN",
  "BRIDGE_TOKEN",
  "TOKEN_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "TAVILY_API_KEY",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_TOKEN",
  "WHATSAPP_OWNER",
  "WHATSAPP_PHONE_ID",
  "WHATSAPP_BUSINESS_ID",
]);
export function plainFile(path) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    throw new Error("Refusing a symlinked setup path");
}
export function privateWrite(path, text) {
  plainFile(dirname(path));
  plainFile(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + ".tmp-" + randomUUID();
  writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
export function readConfig(path) {
  plainFile(path);
  const errors = [];
  const data = parse(readFileSync(path, "utf8"), errors, {
    allowTrailingComma: true,
  });
  if (errors.length || !data || typeof data !== "object")
    throw new Error("Invalid configuration file");
  return data;
}
export function readSecrets(path) {
  plainFile(path);
  if (!existsSync(path)) return {};
  const result = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match || !SECRET_KEYS.has(match[1]) || Object.hasOwn(result, match[1]))
      throw new Error(
        "Invalid/duplicate secret entry; use only documented keys",
      );
    const raw = match[2].trim();
    let value;
    try {
      value = raw.startsWith('"') ? JSON.parse(raw) : raw;
    } catch {
      throw new Error("Invalid quoted secret value");
    }
    if (
      typeof value !== "string" ||
      value.length > 8192 ||
      /[\r\n\0]/.test(value)
    )
      throw new Error("Invalid secret value");
    result[match[1]] = value;
  }
  return result;
}
export function writeSecrets(path, secrets) {
  privateWrite(
    path,
    "# Private hej hej credentials. Never commit or share this file.\n" +
      Object.entries(secrets)
        .map(([key, value]) => key + "=" + JSON.stringify(value))
        .join("\n") +
      "\n",
  );
}
export function validUrl(value) {
  const url = new URL(value);
  const local =
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(url.hostname);
  if (
    (!local && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Use an HTTPS origin (or localhost HTTP for development)");
  if (url.hostname.includes("YOUR-WORKER".toLowerCase()))
    throw new Error("Set your Worker URL or run npm run deploy first");
  return url.origin;
}
export function setup(root = ROOT, options = {}) {
  const directory = resolve(root, ".hej-hej"),
    configPath = resolve(directory, "wrangler.json"),
    secretsPath = resolve(directory, ".dev.vars");
  plainFile(directory);
  if (!existsSync(configPath) && existsSync(resolve(root, ".dev.vars")))
    throw new Error(
      "Existing manual .dev.vars found. Keep the documented manual setup rather than creating new credentials; migration must be explicit.",
    );
  const config = existsSync(configPath)
    ? readConfig(configPath)
    : readConfig(resolve(root, "wrangler.jsonc"));
  if (options.name && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.name))
    throw new Error(
      "Worker name must use lowercase letters, numbers and hyphens",
    );
  if (existsSync(configPath) && options.name && options.name !== config.name)
    throw new Error(
      "Changing an existing Worker name would create a new deployment. Migrate explicitly instead.",
    );
  if (options.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email))
    throw new Error("Invalid Gmail owner email");
  if (options.url) config.vars.PUBLIC_URL = validUrl(options.url);
  if (options.name) config.name = options.name;
  if (options.email) config.vars.OWNER_EMAIL = options.email;
  if (!existsSync(configPath))
    config.main = relative(directory, resolve(root, config.main));
  delete config.vars.DEMO_MODE;
  delete config.vars.TEST_MODE;
  const secrets = readSecrets(secretsPath);
  secrets.ADMIN_TOKEN ||= randomBytes(32).toString("hex");
  secrets.BRIDGE_TOKEN ||= randomBytes(32).toString("hex");
  secrets.TOKEN_KEY ||= randomBytes(32).toString("base64");
  validateCore(secrets);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  privateWrite(configPath, JSON.stringify(config, null, 2) + "\n");
  writeSecrets(secretsPath, secrets);
  return { configPath, secretsPath, config };
}
export function validateCore(secrets) {
  if (
    !secrets.ADMIN_TOKEN ||
    secrets.ADMIN_TOKEN.length < 32 ||
    !secrets.BRIDGE_TOKEN ||
    secrets.BRIDGE_TOKEN.length < 32 ||
    secrets.ADMIN_TOKEN === secrets.BRIDGE_TOKEN ||
    !/^[A-Za-z0-9+/]{43}=$/.test(secrets.TOKEN_KEY ?? "") ||
    Buffer.from(secrets.TOKEN_KEY, "base64").length !== 32
  )
    throw new Error(
      "Invalid core credentials; run npm run setup (existing values are never rotated automatically)",
    );
}
export function configuration(
  root = ROOT,
  { local = false, requireAdmin = true } = {},
) {
  const managed = resolve(root, ".hej-hej/wrangler.json");
  const configPath = existsSync(managed)
    ? managed
    : resolve(root, "wrangler.jsonc");
  const config = readConfig(configPath);
  const secrets = readSecrets(resolve(dirname(configPath), ".dev.vars"));
  const url = validUrl(
    local
      ? "http://127.0.0.1:8787"
      : process.env.ASSISTANT_URL || config.vars.PUBLIC_URL,
  );
  const token = process.env.ADMIN_TOKEN || secrets.ADMIN_TOKEN;
  if (requireAdmin && (!token || token.length < 32))
    throw new Error(
      "No admin credential found. Run npm run setup; never paste secrets into command arguments.",
    );
  return { url, token, configPath, config, secrets };
}
export async function api(client, path, method = "GET", body, fetcher = fetch) {
  const r = await fetcher(client.url + path, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: "Bearer " + client.token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const reader = r.body?.getReader();
  let length = 0;
  const chunks = [];
  try {
    if (reader)
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 262144) throw new Error("API response too large");
        chunks.push(value);
      }
  } finally {
    await reader?.cancel().catch(() => {});
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("The server did not return hej hej JSON");
  }
  if (!r.ok)
    throw new Error(
      "API " +
        r.status +
        ": " +
        (typeof value.error === "string"
          ? value.error.slice(0, 300)
          : "Request failed"),
    );
  return value;
}
export async function ask(
  client,
  text,
  { id = randomUUID(), timeout = 130000, fetcher = fetch } = {},
) {
  if (!text.trim() || text.length > 8000)
    throw new Error("Message must contain 1–8000 characters");
  const receipt = await api(
    client,
    "/v1/messages",
    "POST",
    { id, text },
    fetcher,
  );
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const m = await api(
      client,
      "/v1/messages/" + receipt.id,
      "GET",
      undefined,
      fetcher,
    );
    if (!["queued", "running"].includes(m.status)) {
      if (!m.response)
        throw new Error(
          "No assistant response; inspect /v1/messages/" + receipt.id,
        );
      return m;
    }
    await sleep(500);
  }
  throw new Error(
    "Still processing. Inspect /v1/messages/" +
      receipt.id +
      "; do not blindly submit a duplicate.",
  );
}
export async function smoke(client, { fetcher = fetch } = {}) {
  const health = await api(client, "/health", "GET", undefined, fetcher);
  if (health.product !== "hej hej" || !health.ok)
    throw new Error("This is not a hej hej endpoint");
  const unauthorized = await fetcher(client.url + "/v1/status", {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  await unauthorized.body?.cancel();
  if (unauthorized.status !== 401)
    throw new Error(
      "Smoke test failed: unauthenticated access must return 401",
    );
  const id = randomUUID(),
    text = "Hello hej hej. Reply with a short greeting.";
  const m = await ask(client, text, { id, fetcher });
  if (m.completion !== "done")
    throw new Error(
      "The API admitted your message, but generation did not succeed. Inspect the receipt and integration/account setup; do not treat this as a live model pass.",
    );
  const duplicate = await api(
    client,
    "/v1/messages",
    "POST",
    { id, text },
    fetcher,
  );
  if (duplicate.id !== m.id) throw new Error("Idempotency failed");
  return { mode: health.mode, id: m.id, response: m.response };
}
export function wrangler(args, { root = ROOT, input, quiet = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [resolve(root, "node_modules/wrangler/bin/wrangler.js"), ...args],
      {
        cwd: root,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        stdio: [
          input === undefined ? "inherit" : "pipe",
          quiet ? "pipe" : "inherit",
          quiet ? "pipe" : "inherit",
        ],
      },
    );
    let output = "";
    if (quiet) {
      child.stdout.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-65536);
      });
      child.stderr.resume();
    }
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
    child.on("error", () =>
      reject(new Error("Unable to start Wrangler; run npm ci")),
    );
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise(output)
        : reject(
            new Error(
              "Wrangler failed. Check Cloudflare login, Worker name and account permissions.",
            ),
          ),
    );
  });
}
export async function deploy(root = ROOT, run = wrangler) {
  const configPath = resolve(root, ".hej-hej/wrangler.json");
  if (!existsSync(configPath))
    throw new Error("Run npm run setup before managed deployment");
  const config = readConfig(configPath),
    secrets = readSecrets(resolve(dirname(configPath), ".dev.vars"));
  validateCore(secrets);
  const markerPath = resolve(dirname(configPath), "deployed.json");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        ["ADMIN_TOKEN", "BRIDGE_TOKEN", "TOKEN_KEY"].map((key) => secrets[key]),
      ),
    )
    .digest("hex");
  const marker = existsSync(markerPath) ? readConfig(markerPath) : undefined;
  if (
    marker &&
    (marker.name !== config.name || marker.fingerprint !== fingerprint)
  )
    throw new Error(
      "Core credentials or Worker identity changed. Refusing automatic rotation; migrate explicitly.",
    );
  if (config.vars.DEMO_MODE || config.vars.TEST_MODE)
    throw new Error("Refusing a demo/test deployment");
  const placeholder = config.vars.PUBLIC_URL.includes("YOUR-WORKER");
  if (
    !placeholder &&
    new URL(validUrl(config.vars.PUBLIC_URL)).protocol !== "https:"
  )
    throw new Error("A deployed Worker needs an HTTPS public URL");
  const output = await run(["deploy", "--config", configPath], {
    root,
    quiet: true,
  });
  if (placeholder) {
    const discovered = output.match(
      /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b/i,
    )?.[0];
    if (
      !discovered ||
      !new URL(discovered).hostname.startsWith(config.name + ".")
    )
      throw new Error(
        "Worker deployed but URL was not discovered. Re-run setup with --url https://YOUR-ACTUAL-WORKER.workers.dev, then deploy. No credentials have been uploaded yet.",
      );
    config.vars.PUBLIC_URL = validUrl(discovered);
    privateWrite(configPath, JSON.stringify(config, null, 2) + "\n");
    await run(["deploy", "--config", configPath], { root, quiet: true });
  } else validUrl(config.vars.PUBLIC_URL);
  if (!marker) {
    const listed = await run(
      ["secret", "list", "--format", "json", "--config", configPath],
      { root, quiet: true },
    );
    let existing;
    try {
      existing = JSON.parse(listed);
    } catch {
      throw new Error(
        "Could not verify existing Worker secrets; refusing to upload new credentials",
      );
    }
    if (
      !Array.isArray(existing) ||
      existing.some((secret) =>
        ["ADMIN_TOKEN", "BRIDGE_TOKEN", "TOKEN_KEY"].includes(secret.name),
      )
    )
      throw new Error(
        "Existing Worker credentials detected. Refusing to overwrite them. Keep the manual setup or migrate existing keys explicitly.",
      );
  }
  const upload = Object.fromEntries(
    Object.entries(secrets).filter(([, value]) => value),
  );
  // Values travel over stdin, never argv or console output. .dev.vars is local-only.
  await run(["secret", "bulk", "--config", configPath], {
    root,
    input: JSON.stringify(upload),
    quiet: true,
  });
  privateWrite(
    markerPath,
    JSON.stringify({ name: config.name, fingerprint }, null, 2) + "\n",
  );
  return config.vars.PUBLIC_URL;
}
