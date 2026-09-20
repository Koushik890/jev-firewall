import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Decision } from "./types.js";

export interface FirewallConfig {
  /** "model" = decision model decides unmatched actions; "rules" = config.default does. */
  mode: "model" | "rules";
  /** Posture for actions decided without the model (rules-only mode). */
  default: Decision;
  /** Model confidence below this goes to a human. */
  askBelow: number;
  /** User-delegated allows, checked before the model. Keep tiny. */
  safeCommands: string[];
  /** Regex patterns over the action string — a match blocks. */
  blockedPaths: string[];
  /** Basenames that may never appear in any action. */
  protectedFiles: string[];
}

export const DEFAULT_CONFIG: FirewallConfig = {
  mode: "model",
  default: "ask",
  askBelow: 0.7,
  safeCommands: [
    "pwd", "ls", "cat", "head", "tail", "grep", "rg", "find", "which",
    "node --version", "npm test", "npm run build",
    "git status", "git log", "git diff",
  ],
  blockedPaths: ["(^|[/\\\\])\\.ssh([/\\\\]|$)", "(^|[/\\\\])\\.aws([/\\\\]|$)"],
  protectedFiles: [".env", "credentials.json"],
};

const DECISIONS: readonly Decision[] = ["allow", "ask", "block"];

/**
 * Parse the config subset of YAML: top-level scalars and top-level string
 * lists. Unknown keys are an error — a typo'd key must never silently
 * disable a protection.
 */
export function parseConfigYaml(text: string): FirewallConfig {
  const config: FirewallConfig = {
    mode: DEFAULT_CONFIG.mode,
    default: DEFAULT_CONFIG.default,
    askBelow: DEFAULT_CONFIG.askBelow,
    safeCommands: [],
    blockedPaths: [],
    protectedFiles: [],
  };
  let listKey: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    const trimmed = line.trim();
    if (trimmed === "") continue;

    if (trimmed.startsWith("- ")) {
      if (!listKey) throw new Error(`config: list item outside a list: "${trimmed}"`);
      pushListValue(config, listKey, trimmed.slice(2).trim().replace(/^['"]|['"]$/g, ""));
      continue;
    }
    listKey = null;

    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(trimmed);
    if (!m) throw new Error(`config: cannot parse line: "${trimmed}"`);
    const [, key, value] = m;
    if (value === "") {
      listKey = key;
      continue;
    }
    if (value === "[]") {
      // Inline empty list: valid for the three list keys, an error otherwise.
      if (!(key in { safe_commands: 1, blocked_paths: 1, protected_files: 1 })) {
        throw new Error(`config: unknown key "${key}" (typo? see jev-firewall.yaml.example)`);
      }
      continue;
    }
    setScalar(config, key, value.replace(/^['"]|['"]$/g, ""));
  }
  return config;
}

function setScalar(config: FirewallConfig, key: string, value: string): void {
  switch (key) {
    case "default":
      if (!DECISIONS.includes(value as Decision)) {
        throw new Error(`config: default must be one of ${DECISIONS.join("|")}, got "${value}"`);
      }
      config.default = value as Decision;
      return;
    case "ask_below": {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        throw new Error(`config: ask_below must be a number in [0,1], got "${value}"`);
      }
      config.askBelow = n;
      return;
    }
    default:
      throw new Error(`config: unknown key "${key}" (typo? see jev-firewall.yaml.example)`);
  }
}

function pushListValue(config: FirewallConfig, key: string, value: string): void {
  switch (key) {
    case "safe_commands": config.safeCommands.push(value); return;
    case "blocked_paths": config.blockedPaths.push(value); return;
    case "protected_files": config.protectedFiles.push(value); return;
    default:
      throw new Error(`config: unknown list "${key}" (typo? see jev-firewall.yaml.example)`);
  }
}

/** Load config from an explicit path, or discover it, or use defaults. */
export async function loadConfig(explicitPath?: string): Promise<FirewallConfig> {
  const candidates = explicitPath
    ? [explicitPath]
    : ["jev-firewall.yaml", path.join(homedir(), ".jev-firewall.yaml")];
  for (const candidate of candidates) {
    const text = await readFile(candidate, "utf8").catch(() => null);
    if (text !== null) return parseConfigYaml(text);
  }
  return { ...DEFAULT_CONFIG };
}
