import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { ROOT, DEMO_TOKEN, api, ask, smoke } from "./lib.mjs";
const checking = process.argv.includes("--check");
if (!checking && !process.stdin.isTTY) {
  console.error(
    "Interactive demo needs a terminal. Use npm run demo:check for an unattended test.",
  );
  process.exit(1);
}
async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = server.address().port;
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return port;
}
const directory = mkdtempSync(join(tmpdir(), "hej-hej-demo-"));
const port = await freePort();
const child = spawn(
  process.execPath,
  [
    resolve(ROOT, "node_modules/wrangler/bin/wrangler.js"),
    "dev",
    "--local",
    "--config",
    resolve(ROOT, "demo/wrangler.jsonc"),
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    directory,
  ],
  {
    cwd: ROOT,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "",
  ended = false;
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    logs = (logs + chunk.toString()).slice(-4000);
  });
child.on("exit", () => {
  ended = true;
});
child.on("error", () => {
  ended = true;
});
const controller = new AbortController();
const cancel = () => controller.abort();
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
const client = { url: "http://127.0.0.1:" + port, token: DEMO_TOKEN };
let terminal;
try {
  console.log(
    "Starting hej hej offline demo — no keys, accounts, AI calls or real messages. State is temporary.",
  );
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (controller.signal.aborted) break;
    if (ended) throw new Error("Local Worker could not start.\n" + logs);
    try {
      const health = await api(client, "/health");
      if (health.product === "hej hej" && health.mode === "demo") {
        ready = true;
        break;
      }
    } catch {}
    await sleep(250);
  }
  if (controller.signal.aborted) process.exitCode = 0;
  else if (!ready)
    throw new Error("Demo did not become ready within 30 seconds.\n" + logs);
  else if (checking) {
    const result = await smoke(client);
    if (result.mode !== "demo" || !result.response.includes("[OFFLINE DEMO]"))
      throw new Error("Expected a labeled, scripted demo reply");
    for (const path of [
      "/oauth/google/start",
      "/bridge/inbox",
      "/webhooks/whatsapp",
    ]) {
      const r = await fetch(client.url + path, {
        method: "POST",
        headers: { Authorization: "Bearer " + DEMO_TOKEN },
        body: "{}",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      await r.body?.cancel();
      if (r.status !== 404)
        throw new Error("Live integration was not blocked in demo: " + path);
    }
    console.log(
      "PASS: local Worker, authentication, durable Pi reply, dedupe and demo-only integration guard.\n" +
        result.response,
    );
  } else {
    console.log(
      "Try: Hello | Summarize my inbox | /research lightweight CRMs\nReplies are scripted; no real email, internet or messaging account is connected. Type /quit to exit.",
    );
    terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    while (!controller.signal.aborted) {
      let text;
      try {
        text = (
          await terminal.question("you > ", { signal: controller.signal })
        ).trim();
      } catch {
        break;
      }
      if (text === "/quit" || text === "/exit") break;
      if (!text) continue;
      try {
        console.log("\nhej hej > " + (await ask(client, text)).response + "\n");
      } catch (error) {
        console.error(error.message);
      }
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  terminal?.close();
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  if (!ended) {
    child.kill("SIGTERM");
    for (let i = 0; i < 40 && !ended; i++) await sleep(100);
    if (!ended) {
      child.kill("SIGKILL");
      for (let i = 0; i < 20 && !ended; i++) await sleep(100);
    }
  }
  if (ended) rmSync(directory, { recursive: true, force: true });
}
