import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AgentAction, FirewallVerdict } from "./types.js";

export interface LogEntry {
  ts: string;
  agent: string;
  tool: string;
  command: string;
  /** De-obfuscated command when it differs from `command` (substitutions applied, payloads decoded). */
  resolvedCommand?: string;
  cwd: string;
  sessionId?: string;
  decision: FirewallVerdict["decision"];
  probability?: number;
  reason: string;
  contributions: FirewallVerdict["contributions"];
  latencyMs: number;
  model: string;
}

/** Append one JSON line per decision to ~/.jev-firewall/log.jsonl. */
export async function logDecision(action: AgentAction, verdict: FirewallVerdict, modelName: string, logPath?: string): Promise<void> {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    agent: action.agent,
    tool: action.tool,
    command: action.command,
    resolvedCommand: action.resolvedCommand,
    cwd: action.cwd,
    sessionId: action.sessionId,
    decision: verdict.decision,
    probability: verdict.contributions.find((c) => c.source === "model")?.probability,
    reason: verdict.contributions.at(-1)?.reason ?? "unknown",
    contributions: verdict.contributions,
    latencyMs: verdict.latencyMs,
    model: modelName,
  };
  const target = logPath ?? path.join(os.homedir(), ".jev-firewall", "log.jsonl");
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, JSON.stringify(entry) + "\n", "utf8");
}
