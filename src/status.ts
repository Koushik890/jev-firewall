import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadDotEnv } from "./dotenv.js";
import { selectModelFromEnv } from "./model.js";
import { containsMarker, detectAgents, settingsPathFor, type Platform } from "./install.js";

/**
 * `jev-firewall status` — a static (no network) report of how the firewall is
 * wired: which model/key is configured, whether each agent's hook is
 * installed, and how big the audit log is. Pure enough to test: everything
 * reads from an injectable home directory and env.
 */
export interface StatusReport {
  model: { configured: boolean; provider: string; name?: string; keySource: string; hint?: string };
  agents: Record<Platform, { settingsPath: string; detected: boolean; installed: boolean }>;
  auditLog: { path: string; entries: number };
}

/** Where the active key lives, without ever printing the key itself. */
export function keySource(env: NodeJS.ProcessEnv, home: string, cwd: string = process.cwd()): string {
  const names = ["AI_GATEWAY_API_KEY", "TYPESAFE_API_KEY", "TYPESAFE_AI_API_KEY"];
  if (names.some((n) => env[n])) return "environment";
  const candidates: Array<[file: string, label: string]> = [
    [path.join(cwd, ".env"), "project .env"],
    [path.join(home, ".jev-firewall", ".env"), "~/.jev-firewall/.env"],
  ];
  for (const [file, label] of candidates) {
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, "utf8");
      if (names.some((n) => new RegExp(`^\\s*${n}\\s*=`, "m").test(text))) return label;
    } catch {
      continue;
    }
  }
  return "none";
}

function hookInstalled(settingsPath: string): boolean {
  if (!existsSync(settingsPath)) return false;
  try {
    return containsMarker(JSON.parse(readFileSync(settingsPath, "utf8")));
  } catch {
    return false;
  }
}

function countLines(file: string): number {
  if (!existsSync(file)) return 0;
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

export function collectStatus(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  options: { dotenv?: boolean; cwd?: string } = {},
): StatusReport {
  // dotenv:false keeps tests hermetic (no accidental pickup of a real .env).
  const merged = options.dotenv === false ? env : loadDotEnv(env);
  const sel = selectModelFromEnv(merged);
  const detection = detectAgents(home);
  const auditPath = path.join(home, ".jev-firewall", "log.jsonl");

  const model =
    sel.provider === "none"
      ? { configured: false, provider: "none", keySource: keySource(merged, home, options.cwd), hint: sel.reason }
      : { configured: true, provider: sel.provider, name: sel.model.name, keySource: keySource(merged, home, options.cwd) };

  const agents = {
    claude: { settingsPath: settingsPathFor("claude", home), detected: detection.claude, installed: hookInstalled(settingsPathFor("claude", home)) },
    codex: { settingsPath: settingsPathFor("codex", home), detected: detection.codex, installed: hookInstalled(settingsPathFor("codex", home)) },
  };

  return { model, agents, auditLog: { path: auditPath, entries: countLines(auditPath) } };
}

export function formatStatus(r: StatusReport): string {
  const lines: string[] = [];
  lines.push("jev-firewall status");
  lines.push("");
  if (r.model.configured) {
    lines.push(`  model      ${r.model.name} via ${r.model.provider} — key from ${r.model.keySource}`);
    lines.push("             live check: jev-firewall doctor");
  } else {
    lines.push(`  model      NOT CONFIGURED — ${r.model.hint ?? "no key found"}`);
    lines.push("             fix: jev-firewall setup");
  }
  for (const [name, agent] of Object.entries(r.agents) as Array<[Platform, StatusReport["agents"][Platform]]>) {
    const state = agent.installed ? "hook installed" : agent.detected ? "detected, hook NOT installed" : "not detected";
    lines.push(`  ${name.padEnd(10)} ${state} → ${agent.settingsPath}`);
  }
  lines.push(`  audit log  ${r.auditLog.entries} ${r.auditLog.entries === 1 ? "entry" : "entries"} → ${r.auditLog.path}`);
  return lines.join("\n");
}
