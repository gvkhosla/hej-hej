import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setup,
  readConfig,
  readSecrets,
  writeSecrets,
  validUrl,
  deploy,
  configuration,
  api,
  ask,
  smoke,
} from "./lib.mjs";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "hej-hej-setup-"));
  writeFileSync(
    join(root, "wrangler.jsonc"),
    '{ // supported JSONC\n "name":"hej-hej", "main":"src/worker.ts", "vars":{"PUBLIC_URL":"https://YOUR-WORKER.workers.dev","OWNER_EMAIL":"you@example.com"}, }',
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("setup is private, idempotent, preserves core keys and does not edit the shared config", (t) => {
  const root = fixture(t),
    base = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  const first = setup(root, { email: "owner@example.com" }),
    secrets = readSecrets(first.secretsPath);
  assert.equal(secrets.ADMIN_TOKEN.length, 64);
  assert.notEqual(secrets.ADMIN_TOKEN, secrets.BRIDGE_TOKEN);
  assert.equal(Buffer.from(secrets.TOKEN_KEY, "base64").length, 32);
  assert.equal(statSync(first.secretsPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, ".hej-hej")).mode & 0o777, 0o700);
  setup(root, { url: "https://hej-hej.owner.workers.dev" });
  assert.deepEqual(readSecrets(first.secretsPath), secrets);
  assert.equal(readFileSync(join(root, "wrangler.jsonc"), "utf8"), base);
  assert.equal(readConfig(first.configPath).main, "../src/worker.ts");
});
test("setup rejects identity changes and invalid owner/URL inputs", (t) => {
  const root = fixture(t);
  assert.throws(() => setup(root, { name: "Bad Name" }), /name/);
  assert.throws(() => setup(root, { email: "no-email" }), /email/);
  assert.throws(() => setup(root, { url: "http://evil.com" }), /HTTPS/);
  setup(root);
  assert.throws(
    () => setup(root, { name: "different-worker" }),
    /new deployment/,
  );
});
test("legacy credentials are not silently replaced", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, ".dev.vars"), "ADMIN_TOKEN=legacy");
  assert.throws(() => setup(root), /Existing manual/);
});
test("setup refuses a symlinked credential file", (t) => {
  const root = fixture(t),
    prepared = setup(root),
    outside = join(root, "outside");
  writeFileSync(outside, "unchanged");
  rmSync(prepared.secretsPath);
  symlinkSync(outside, prepared.secretsPath);
  assert.throws(() => setup(root), /symlink/);
  assert.equal(readFileSync(outside, "utf8"), "unchanged");
});
test("secrets parsing supports quotes but rejects unknown flags and duplicate keys", (t) => {
  const root = fixture(t),
    { secretsPath } = setup(root);
  const secrets = readSecrets(secretsPath);
  secrets.TAVILY_API_KEY = 'contains "quotes" and spaces';
  writeSecrets(secretsPath, secrets);
  assert.equal(readSecrets(secretsPath).TAVILY_API_KEY, secrets.TAVILY_API_KEY);
  writeFileSync(secretsPath, 'DEMO_MODE="true"\n');
  assert.throws(() => readSecrets(secretsPath), /Invalid/);
  writeFileSync(secretsPath, 'ADMIN_TOKEN="one"\nADMIN_TOKEN="two"');
  assert.throws(() => readSecrets(secretsPath), /duplicate/);
});
test("origins reject insecure, credentialed and path-bearing URLs", () => {
  for (const url of [
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com/path",
    "https://example.com/?token=x",
    "https://example.com/#fragment",
  ])
    assert.throws(() => validUrl(url));
  assert.equal(validUrl("http://localhost:8787"), "http://localhost:8787");
});
test("deployment discovers the URL and pipes secrets, never putting them in argv", async (t) => {
  const root = fixture(t),
    { secretsPath } = setup(root),
    secrets = readSecrets(secretsPath),
    calls = [];
  const run = async (args, options) => {
    calls.push({ args, options });
    return args[0] === "deploy"
      ? "Published\n https://hej-hej.owner.workers.dev\n"
      : args[1] === "list"
        ? "[]"
        : "";
  };
  assert.equal(await deploy(root, run), "https://hej-hej.owner.workers.dev");
  assert.equal(calls.filter((c) => c.args[0] === "deploy").length, 2);
  const upload = calls.find((c) => c.args[1] === "bulk");
  assert.equal(
    JSON.parse(upload.options.input).ADMIN_TOKEN,
    secrets.ADMIN_TOKEN,
  );
  assert.equal(
    JSON.stringify(upload.args).includes(secrets.ADMIN_TOKEN),
    false,
  );
  assert.equal(
    statSync(join(root, ".hej-hej/deployed.json")).mode & 0o777,
    0o600,
  );
  calls.length = 0;
  await deploy(root, run);
  assert.equal(calls.filter((c) => c.args[0] === "deploy").length, 1);
  assert.equal(
    calls.some((c) => c.args[1] === "list"),
    false,
  );
});
test("deployment does not overwrite existing remote core credentials", async (t) => {
  const root = fixture(t);
  setup(root);
  let uploads = 0;
  const run = async (args) =>
    args[0] === "deploy"
      ? "https://hej-hej.owner.workers.dev"
      : args[1] === "list"
        ? '[{"name":"TOKEN_KEY"}]'
        : (++uploads, "");
  await assert.rejects(deploy(root, run), /Refusing to overwrite/);
  assert.equal(uploads, 0);
});
test("deployment refuses implicit core key rotation before invoking Wrangler", async (t) => {
  const root = fixture(t),
    { secretsPath } = setup(root);
  const run = async (args) =>
    args[0] === "deploy"
      ? "https://hej-hej.owner.workers.dev"
      : args[1] === "list"
        ? "[]"
        : "";
  await deploy(root, run);
  const secrets = readSecrets(secretsPath);
  secrets.TOKEN_KEY = Buffer.alloc(32, 1).toString("base64");
  writeSecrets(secretsPath, secrets);
  let commands = 0;
  await assert.rejects(
    deploy(root, async () => {
      commands++;
      return "";
    }),
    /Refusing automatic rotation/,
  );
  assert.equal(commands, 0);
});
test("deployment fails closed on undiscovered URLs or demo flags", async (t) => {
  const root = fixture(t),
    { configPath } = setup(root);
  let calls = 0;
  await assert.rejects(
    deploy(root, async () => {
      calls++;
      return "no URL";
    }),
    /URL was not discovered/,
  );
  assert.equal(calls, 1);
  const config = readConfig(configPath);
  config.vars.DEMO_MODE = "true";
  writeFileSync(configPath, JSON.stringify(config));
  calls = 0;
  await assert.rejects(
    deploy(root, async () => {
      calls++;
      return "";
    }),
    /demo/,
  );
  assert.equal(calls, 0);
});
test("API client uses bearer headers, not URLs, and bounds responses", async () => {
  const client = { url: "https://worker.example.com", token: "private-token" };
  let request;
  const value = await api(
    client,
    "/v1/status",
    "GET",
    undefined,
    async (url, init) => {
      request = { url, init };
      return new Response('{"ok":true}');
    },
  );
  assert.deepEqual(value, { ok: true });
  assert.equal(request.url.includes(client.token), false);
  assert.equal(request.init.headers.Authorization, "Bearer private-token");
  assert.equal(request.init.redirect, "error");
  await assert.rejects(
    api(
      client,
      "/v1/status",
      "GET",
      undefined,
      async () => new Response("x".repeat(262145)),
    ),
    /too large/,
  );
});
test("ask polls the admitted receipt and returns its response", async () => {
  let polls = 0;
  const fetcher = async (url, init) => {
    if (init.method === "POST") return new Response('{"id":"api-receipt"}');
    polls++;
    return new Response(
      JSON.stringify(
        polls === 1
          ? { status: "running" }
          : { id: "api-receipt", status: "ready", response: "hello" },
      ),
    );
  };
  assert.equal(
    (await ask({ url: "http://localhost:1", token: "x" }, "hello", { fetcher }))
      .response,
    "hello",
  );
  assert.equal(polls, 2);
});
test("smoke checks unauthenticated denial and stable duplicate IDs", async () => {
  let incomingId;
  const fetcher = async (url, init = {}) => {
    if (url.endsWith("/health"))
      return new Response('{"ok":true,"product":"hej hej","mode":"demo"}');
    if (url.endsWith("/v1/status")) return new Response("{}", { status: 401 });
    if (init.method === "POST") {
      const input = JSON.parse(init.body);
      if (incomingId) assert.equal(input.id, incomingId);
      incomingId = input.id;
      return new Response('{"id":"receipt"}');
    }
    return new Response(
      '{"id":"receipt","status":"ready","completion":"done","response":"[OFFLINE DEMO]"}',
    );
  };
  assert.equal(
    (await smoke({ url: "http://localhost:1", token: "x" }, { fetcher })).mode,
    "demo",
  );
});
