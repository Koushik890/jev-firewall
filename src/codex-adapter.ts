import type { AgentAction, Decision, FirewallVerdict } from "./types.js";

/**
 * Codex adapter — translates Codex CLI hook events onto the shared core.
 *
 * Codex's hook surface (registered in ~/.codex/hooks.json) is modeled on
 * Claude Code's: one JSON event on stdin, one JSON decision on stdout. Two
 * documented differences drive this adapter:
 *
 * 1. Codex acts on "deny"; anything else runs as-is. "ask" is accepted by
 *    current builds but is not guaranteed on every one, so the adapter offers
 *    a strict posture — JEVD_CODEX_ASK=deny escalates every ASK to DENY
 *    (fail-closed for users who never want a silent pass on uncertainty).
 * 2. Codex requires the user to review and trust each hook definition before
 *    it runs (`/hooks` in Codex); the installer prints that step.
 *
 * Codex's exact payload field names have drifted across releases, so
 * extraction is defensive: common fields first, then a recursive scan, and
 * finally the whole event as text — the rules and model scan text anyway, so
 * a drifted schema degrades to coarse matching instead of blindness.
 */

/** The subset of Codex hook payloads this adapter reads (with aliases). */
export interface CodexHookInput {
  session_id?: string;
  conversation_id?: string;
  cwd?: string;
  tool_name?: string;
  /** Alias some builds use instead of tool_name. */
  tool?: string;
  tool_input?: Record<string, unknown>;
  /** Alias some builds use instead of tool_input. */
  input?: Record<string, unknown>;
}

/** Pull the first meaningful string field out of an object, recursively. */
function extractCommand(obj: Record<string, unknown>, depth = 0): string | null {
  if (depth > 3) return null;
  for (const key of ["command", "cmd", "file_path", "path", "patch", "url"]) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object") {
      const inner = extractCommand(value as Record<string, unknown>, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

/** Translate a Codex hook payload into the core's normalized action. */
export function actionFromCodex(input: CodexHookInput): AgentAction {
  const tool = String(input.tool_name ?? input.tool ?? "").toLowerCase();
  const toolInput = input.tool_input ?? input.input ?? {};
  const command = extractCommand(toolInput) ?? extractCommand(input as unknown as Record<string, unknown>) ?? JSON.stringify(input);
  return {
    agent: "codex",
    tool,
    command,
    cwd: input.cwd ?? process.cwd(),
    sessionId: input.session_id ?? input.conversation_id,
  };
}

export interface CodexResponseOptions {
  /** JEVD_CODEX_ASK=deny posture: escalate ASK to DENY (fail-closed). */
  askAsDeny?: boolean;
}

/**
 * Map a core verdict onto Codex's response contract:
 * block → deny, ask → ask (or deny under the strict posture),
 * allow → {} (Codex runs anything that is not a deny).
 */
export function codexResponse(decision: Decision, reason: string, options: CodexResponseOptions = {}): Record<string, unknown> {
  if (decision === "block") {
    return { permissionDecision: "deny", permissionDecisionReason: reason };
  }
  if (decision === "ask") {
    if (options.askAsDeny) {
      return { permissionDecision: "deny", permissionDecisionReason: `${reason} [ASK escalated to deny by JEVD_CODEX_ASK=deny]` };
    }
    return { permissionDecision: "ask", permissionDecisionReason: reason };
  }
  return {};
}

/** Fail-closed response for unparseable payloads: deny with the reason. */
export function codexFailClosed(reason: string): string {
  return JSON.stringify({
    permissionDecision: "deny",
    permissionDecisionReason: `jev-firewall: ${reason}`,
  });
}

export function codexResponseText(verdict: FirewallVerdict, reason: string, options: CodexResponseOptions = {}): string {
  return JSON.stringify(codexResponse(verdict.decision, reason, options));
}
