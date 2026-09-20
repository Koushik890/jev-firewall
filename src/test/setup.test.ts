import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectAgents, installPlatform, onPath, settingsPathFor } from "../install.js";
import { runSetup, validateKey, homeEnvPath } from "../setup.js";
import { collectStatus, formatStatus, keySource } from "../status.js";
import { createModelFromEnv } from "../model.js";

function tempHome(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// ---------- detection ----------

test("detect: home-dir markers and PATH both count as installed", () => {
  const home = tempHome("jevd-detect-");
  try {
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    assert.deepEqual(detectAgents(home, ""), { claude: true, codex: false });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("onPath: finds a binary on a PATH-style string", () => {
  const dir = tempHome("jevd-path-");
  try {
    const bin = process.platform === "win32" ? "jev-fw-fake.cmd" : "jev-fw-fake";
    writeFileSync(path.join(dir, bin), process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
    assert.equal(onPath("jev-fw-fake", dir), true);
    assert.equal(onPath("jev-fw-definitely-missing", dir), false);
    assert.equal(onPath("anything", undefined), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- installPlatform against a temp home ----------

test("install: writes Claude settings.json and is idempotent", () => {
  const home = tempHome("jevd-inst-");
  try {
    const first = installPlatform("claude", home);
    assert.equal(first.status, "installed");
    const doc = JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8")) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    assert.ok(doc.hooks.PreToolUse[0].hooks[0].command.includes(`agent-hook.js" claude`));
    const second = installPlatform("claude", home);
    assert.equal(second.status, "already");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install: writes Codex hooks.json and preserves other entries", () => {
  const home = tempHome("jevd-inst2-");
  try {
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(path.join(home, ".codex", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ command: "other" }] } }), "utf8");
    const outcome = installPlatform("codex", home);
    assert.equal(outcome.status, "installed");
    const doc = JSON.parse(readFileSync(path.join(home, ".codex", "hooks.json"), "utf8")) as {
      hooks: { PreToolUse: Array<{ command: string }> };
    };
    assert.equal(doc.hooks.PreToolUse.length, 2);
    assert.equal(doc.hooks.PreToolUse[0].command, "other");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install: corrupt settings file is an honest error, not a clobber", () => {
  const home = tempHome("jevd-inst3-");
  try {
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "settings.json"), "{not json", "utf8");
    const outcome = installPlatform("claude", home);
    assert.equal(outcome.status, "error");
    assert.match(outcome.error ?? "", /not valid JSON/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("settingsPathFor: platform-specific paths under the given home", () => {
  assert.equal(settingsPathFor("claude", "/h"), path.join("/h", ".claude", "settings.json"));
  assert.equal(settingsPathFor("codex", "/h"), path.join("/h", ".codex", "hooks.json"));
});

// ---------- setup wizard ----------

function okFetch(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ answers: { decision: { choice: "allow", probabilities: { allow: 0.9, ask: 0.05, block: 0.05 } } } }), {
      status: 200,
    })) as unknown as typeof fetch;
}

function badFetch(): typeof fetch {
  return (async () => new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 })) as unknown as typeof fetch;
}

test("validateKey: a live Jev answer validates the key", async () => {
  const r = await validateKey("gateway", "k", okFetch());
  assert.equal(r.ok, true);
  assert.match(r.detail, /Jev answered/);
});

test("validateKey: 401 fails with a check-the-key hint", async () => {
  const r = await validateKey("gateway", "bad", badFetch());
  assert.equal(r.ok, false);
  assert.match(r.detail, /401/);
});

test("validateKey: billing-gated accounts count as a valid key", async () => {
  const billing = (async () =>
    new Response(JSON.stringify({ error: { message: "customer_verification_required: add a credit card" } }), { status: 403 })) as unknown as typeof fetch;
  const r = await validateKey("gateway", "k", billing);
  assert.equal(r.ok, true);
  assert.match(r.detail, /credit card/);
});

test("validateKey: network failure is an honest no", async () => {
  const down = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const r = await validateKey("typesafe", "k", down);
  assert.equal(r.ok, false);
  assert.match(r.detail, /unreachable/);
});

test("setup: full flow — provider choice, key validation, save, install for detected agents", async () => {
  const home = tempHome("jevd-setup-");
  const answers = ["2", "vck_test_key_123", ""]; // gateway, key, install-for-all
  const lines: string[] = [];
  try {
    const code = await runSetup({
      home,
      input: async () => answers.shift() ?? "",
      log: (line) => lines.push(line),
      fetchImpl: okFetch(),
    });
    assert.equal(code, 0);
    const envText = readFileSync(homeEnvPath(home), "utf8");
    assert.match(envText, /JEVD_PROVIDER=gateway/);
    assert.match(envText, /AI_GATEWAY_API_KEY=vck_test_key_123/);
    assert.ok(lines.some((l) => l.includes("installed")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup: a rejected key writes nothing and exits non-zero", async () => {
  const lines: string[] = [];
  const code = await runSetup({
    provider: "typesafe",
    key: "nope",
    log: (line) => lines.push(line),
    fetchImpl: badFetch(),
  });
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.includes("nothing was written")));
});

test("setup: --yes with no prompts installs for every detected agent", async () => {
  const lines: string[] = [];
  const code = await runSetup({
    provider: "gateway",
    key: "k",
    yes: true,
    log: (line) => lines.push(line),
    fetchImpl: okFetch(),
  });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes("claude")));
  assert.ok(lines.some((l) => l.includes("codex")));
});

test("setup: empty key aborts before any write", async () => {
  const lines: string[] = [];
  const code = await runSetup({
    provider: "gateway",
    input: async () => "   ",
    log: (line) => lines.push(line),
    fetchImpl: okFetch(),
  });
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.includes("nothing was written")));
});

// ---------- status ----------

test("status: keyless report says NOT CONFIGURED with the setup hint", () => {
  const r = collectStatus({}, "/nonexistent-home-jevd", { dotenv: false, cwd: "/nonexistent-cwd-jevd" });
  assert.equal(r.model.configured, false);
  assert.equal(r.model.keySource, "none");
  const text = formatStatus(r);
  assert.match(text, /NOT CONFIGURED/);
  assert.match(text, /jev-firewall setup/);
});

test("status: with a key env var the model is configured and agents are reported", () => {
  const r = collectStatus({ AI_GATEWAY_API_KEY: "k" }, "/nonexistent-home-jevd", { dotenv: false, cwd: "/nonexistent-cwd-jevd" });
  assert.equal(r.model.configured, true);
  assert.equal(r.model.provider, "gateway");
  assert.equal(r.model.name, "jev");
  assert.equal(r.model.keySource, "environment");
  const text = formatStatus(r);
  assert.match(text, /jev via gateway/);
  assert.match(text, /hook installed|NOT installed|not detected/);
});

test("keySource: detects the home .env written by setup", () => {
  const home = tempHome("jevd-src-");
  try {
    mkdirSync(path.join(home, ".jev-firewall"), { recursive: true });
    writeFileSync(path.join(home, ".jev-firewall", ".env"), "JEVD_PROVIDER=typesafe\nTYPESAFE_API_KEY=x\n", "utf8");
    assert.equal(keySource({}, home, "/nonexistent-cwd-jevd"), "~/.jev-firewall/.env");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("status: installed hooks are detected through the marker", () => {
  const home = tempHome("jevd-st-");
  try {
    installPlatform("claude", home);
    const r = collectStatus({}, home);
    assert.equal(r.agents.claude.installed, true);
    assert.equal(r.agents.codex.installed, false);
    assert.ok(existsSync(path.join(home, ".claude", "settings.json")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------- selection ↔ factory coherence ----------

test("selection: gateway key → jev; typesafe key + provider → jev-direct; none → null", () => {
  assert.equal(createModelFromEnv({ AI_GATEWAY_API_KEY: "k" })?.name, "jev");
  assert.equal(createModelFromEnv({ TYPESAFE_API_KEY: "k", JEVD_PROVIDER: "typesafe" })?.name, "jev-direct");
  assert.equal(createModelFromEnv({}), null);
});
