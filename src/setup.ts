import { detectAgents, installPlatform, type Platform } from "./install.js";
import type { Provider } from "./model.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

/**
 * `jev-firewall setup` — the one-command onboarding:
 *   1. Pick a provider: TypeSafe direct (console.typesafe.ai key) or the
 *      Vercel AI Gateway (vck_… key).
 *   2. Paste the key; it is validated with one real Jev call (a billing gate
 *      counts as valid — the key is right, the account needs a card).
 *   3. The key is written to ~/.jev-firewall/.env (0600) where every hook
 *      subprocess finds it, whatever the cwd.
 *   4. Detect Claude Code and Codex on this machine and wire their PreToolUse
 *      hooks automatically.
 *
 * Every prompt is skippable: `--provider`/`--key`/`--yes` flags, or injectable
 * `input`/`log`/`home` for tests (nothing touches the real home in tests).
 */

export interface SetupOptions {
  provider?: string;
  key?: string;
  /** Non-interactive: install for every detected agent, no prompts. */
  yes?: boolean;
  /** Home directory override (tests); defaults to the real home. */
  home?: string;
  stdin?: NodeJS.ReadableStream;
  input?: (prompt: string) => Promise<string>;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}

/** One real Jev call — the cheapest possible proof the key works. */
export async function validateKey(provider: Provider, key: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<{ ok: boolean; detail: string }> {
  const base = provider === "typesafe" ? "https://api.typesafe.ai/v1/systemone" : "https://ai-gateway.vercel.sh/v1/evaluate";
  const model = provider === "typesafe" ? "jev-latest" : "typesafe-ai/jev";
  try {
    const res = await fetchImpl(base, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        state: "command: git status",
        questions: {
          decision: {
            type: "choice",
            instructions: "Classify this tool call for a firewall.",
            criteria: { allow: "safe read-only", ask: "state-changing", block: "destructive or exfiltrating" },
          },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text().catch(() => "");
    if (res.ok) return { ok: true, detail: `Jev answered (HTTP ${res.status})` };
    if (/credit card|customer_verification_required/i.test(text)) {
      return { ok: true, detail: "key accepted, but the provider account needs a credit card on file before real calls succeed" };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, detail: `rejected (HTTP ${res.status}) — check the key` };
    return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 140)}` };
  } catch (err) {
    return { ok: false, detail: `unreachable: ${err instanceof Error ? err.message : err}` };
  }
}

export function homeEnvPath(home: string = homedir()): string {
  return path.join(home, ".jev-firewall", ".env");
}

function writeHomeEnv(home: string, provider: Provider, key: string): void {
  const dir = path.join(home, ".jev-firewall");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, ".env");
  const lines = [
    "# Written by `jev-firewall setup` — the key every hook subprocess loads.",
    `JEVD_PROVIDER=${provider}`,
    provider === "typesafe" ? `TYPESAFE_API_KEY=${key}` : `AI_GATEWAY_API_KEY=${key}`,
    "",
  ];
  try {
    writeFileSync(file, lines.join("\n"), { mode: 0o600 });
  } catch {
    // chmod may be unsupported on some filesystems; content still written.
    writeFileSync(file, lines.join("\n"));
  }
}

function alreadyHasKey(home: string): Provider | null {
  const file = homeEnvPath(home);
  if (!existsSync(file)) return null;
  try {
    const text = readFileSync(file, "utf8");
    if (/^AI_GATEWAY_API_KEY=/m.test(text)) return "gateway";
    if (/^TYPESAFE_API_KEY=/m.test(text)) return "typesafe";
  } catch {
    return null;
  }
  return null;
}

async function ask(question: string, options: SetupOptions): Promise<string> {
  if (options.input) return options.input(question);
  const rl = createInterface({ input: options.stdin ?? process.stdin, terminal: false });
  process.stdout.write(question);
  const answer = await new Promise<string>((resolve) => rl.once("line", resolve));
  rl.close();
  return answer.trim();
}

export async function runSetup(options: SetupOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const home = options.home ?? homedir();
  const envFile = homeEnvPath(home);

  log("jev-firewall setup");
  log("");

  // ---- 1. provider ---------------------------------------------------------
  let provider: Provider;
  const existing = alreadyHasKey(home);
  if (options.provider === "typesafe" || options.provider === "gateway" || options.provider === "vercel") {
    provider = options.provider === "typesafe" ? "typesafe" : "gateway";
    log(`provider: ${provider} (from --provider)`);
  } else if (existing && options.yes) {
    provider = existing;
    log(`provider: ${provider} (existing key in ${envFile})`);
  } else {
    if (existing) log(`note: a ${existing} key already exists in ${envFile}; choosing again overwrites it.`);
    const choice = await ask("Provider — 1) TypeSafe direct (console.typesafe.ai)  2) Vercel AI Gateway  [1/2, default 1]: ", options);
    provider = choice.trim().startsWith("2") ? "gateway" : "typesafe";
    log(`provider: ${provider}`);
  }
  log("");

  // ---- 2. key + validation -------------------------------------------------
  let key = options.key;
  if (!key) {
    const hint = provider === "typesafe" ? "https://console.typesafe.ai → API Keys" : "https://vercel.com → AI Gateway (vck_…)";
    key = await ask(`Paste your ${provider === "typesafe" ? "TypeSafe" : "AI Gateway"} key (${hint}): `, options);
  }
  key = (key ?? "").trim();
  if (!key) {
    log("no key entered — setup aborted (nothing was written)");
    return 1;
  }
  log("validating key with a live Jev call…");
  const check = await validateKey(provider, key, options.fetchImpl);
  log(`  ${check.ok ? "✓" : "✗"} ${check.detail}`);
  if (!check.ok) {
    log("key not accepted — nothing was written. Get a key and re-run `jev-firewall setup`.");
    return 1;
  }
  log("");

  // ---- 3. persist ----------------------------------------------------------
  writeHomeEnv(home, provider, key);
  log(`key saved to ${envFile} (mode 0600) — every hook subprocess loads it automatically.`);
  log("");

  // ---- 4. detect + install -------------------------------------------------
  const detected = detectAgents(home);
  const found = (Object.keys(detected) as Platform[]).filter((p) => detected[p]);
  if (found.length === 0) {
    log("no Claude Code or Codex installation detected on this machine.");
    log("re-run `jev-firewall setup` after installing one of them.");
    return 0;
  }

  const targets = options.yes ? found : await askTargets(found, options, log);
  for (const target of targets) {
    const outcome = installPlatform(target, home);
    if (outcome.status === "error") {
      log(`  ✗ ${outcome.path}: ${outcome.error}`);
      continue;
    }
    const verb = outcome.status === "already" ? "already installed" : "installed";
    log(`  ✓ ${target}: ${verb} → ${outcome.path}`);
    if (target === "codex" && outcome.status === "installed") {
      log("    next: run /hooks inside Codex and TRUST the jev-firewall entry (untrusted hooks do not run).");
    }
    if (target === "claude" && outcome.status === "installed") {
      log("    next: restart Claude Code to pick up the new hook.");
    }
  }
  log("");
  log("done. watch decisions with: jev-firewall logs");
  return 0;
}

async function askTargets(found: Platform[], options: SetupOptions, log: (line: string) => void): Promise<Platform[]> {
  const answer = await ask(
    `Install the firewall hook for: ${found.map((f, i) => `${i + 1}) ${f}`).join("  ")}  (comma-separated, Enter = all): `,
    options,
  );
  const trimmed = answer.trim();
  if (!trimmed) return found;
  const picked = trimmed
    .split(/[,\s]+/)
    .map((token) => found[Number(token) - 1])
    .filter((p): p is Platform => Boolean(p));
  if (picked.length === 0) {
    log(`no valid selection (${answer.trim()}) — installing for all detected: ${found.join(", ")}`);
    return found;
  }
  return picked;
}
