import { createModelFromEnv } from "./model.js";
import { loadConfig } from "./config.js";
import { checkFull } from "./decide.js";
import { logDecision } from "./log.js";
import type { AgentAction, FirewallVerdict } from "./types.js";
import type { FirewallConfig } from "./config.js";
import type { DecisionModel } from "./model.js";
import { actionFromClaude, claudeResponse, type ClaudeHookInput, type ClaudeHookOutput } from "./claude-adapter.js";
import {
  actionFromCodex,
  codexResponseText,
  codexFailClosed,
  type CodexHookInput,
  type CodexResponseOptions,
} from "./codex-adapter.js";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { loadDotEnv } from "./dotenv.js";

export * from "./types.js";
export { loadConfig, DEFAULT_CONFIG } from "./config.js";
export { check, combine, checkFull } from "./decide.js";
export { createModelFromEnv, selectModelFromEnv, JevModel, TypeSafeJevModel } from "./model.js";
export type { ModelSelection, Provider } from "./model.js";
export { logDecision } from "./log.js";
export { containsMarker, hookCommandFor, MARKER } from "./install.js";

export interface Firewall {
  config: FirewallConfig;
  /** null = no model key configured: unmatched actions fall back to the
   *  default posture (fail closed). `jev-firewall setup` fixes the gap. */
  model: DecisionModel | null;
}

export async function createFirewall(env: NodeJS.ProcessEnv = process.env): Promise<Firewall> {
  const merged = loadDotEnv(env);
  const config = await loadConfig(merged.JEVD_CONFIG);
  const model = createModelFromEnv(merged);
  return { config, model };
}

/** One full check: decide + audit log (with the de-obfuscated command). Used by every adapter and the CLI. */
export async function checkAction(firewall: Firewall, action: AgentAction): Promise<FirewallVerdict> {
  const { verdict, resolved } = await checkFull(action, firewall.config, firewall.model);
  const logged = resolved.resolvedText && resolved.resolvedText !== action.command ? { ...action, resolvedCommand: resolved.resolvedText } : action;
  await logDecision(logged, verdict, firewall.model?.name ?? "none").catch(() => {
    // A logging failure must never take down enforcement.
  });
  return verdict;
}

/**
 * A platform adapter for the shared hook loop: turn a parsed payload into a
 * normalized action, a verdict into an output line, and name the fail-closed
 * line for unparseable payloads.
 */
export interface HookAdapter {
  toAction(payload: unknown): AgentAction;
  respond(verdict: FirewallVerdict, reason: string): string;
  failClosed(): string;
}

export const claudeHookAdapter: HookAdapter = {
  toAction: (payload) => actionFromClaude(payload as ClaudeHookInput),
  respond: (verdict, reason) => JSON.stringify(claudeResponse(verdict.decision, reason)),
  failClosed: () => JSON.stringify(claudeResponse("block", "jev-firewall: unparseable hook payload, failing closed")),
};

export function codexHookAdapter(options: CodexResponseOptions = {}): HookAdapter {
  return {
    toAction: (payload) => actionFromCodex(payload as CodexHookInput),
    respond: (verdict, reason) => codexResponseText(verdict, reason, options),
    failClosed: () => codexFailClosed("unparseable hook payload, failing closed"),
  };
}

/**
 * Shared hook loop: one JSON event per line on stdin, one JSON decision per
 * line on stdout, exit on stdin close. Because both agents invoke the hook
 * command once per tool call, the loop normally serves exactly one event;
 * reading all of stdin keeps it correct either way. Unparseable input fails
 * closed via the adapter.
 */
export async function startHookLoop(firewall: Firewall, adapter: HookAdapter, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      output.write(adapter.failClosed() + "\n");
      continue;
    }
    const verdict = await checkAction(firewall, adapter.toAction(payload));
    output.write(adapter.respond(verdict, finalReason(verdict)) + "\n");
  }
}

/** Claude Code PreToolUse hook loop. */
export async function startClaudeHook(firewall: Firewall, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  return startHookLoop(firewall, claudeHookAdapter, input, output);
}

/** Codex PreToolUse hook loop. `options.askAsDeny` = JEVD_CODEX_ASK=deny posture. */
export async function startCodexHook(firewall: Firewall, input: Readable = process.stdin, output: Writable = process.stdout, options: CodexResponseOptions = {}): Promise<void> {
  return startHookLoop(firewall, codexHookAdapter(options), input, output);
}

/**
 * Human-readable final reason: prefer a contribution whose decision matches
 * the final call (the decisive one), falling back to the last contribution.
 */
export function finalReason(verdict: FirewallVerdict): string {
  // Last matching contribution wins: later layers refine earlier ones (the
  // model's verdict should explain an ASK, not the rule's "no rule matched").
  const decisive = [...verdict.contributions].reverse().find((c) => c.decision === verdict.decision) ?? verdict.contributions.at(-1);
  const head = `jev-firewall: ${verdict.decision.toUpperCase()}`;
  return decisive ? `${head} — ${decisive.reason}` : head;
}
