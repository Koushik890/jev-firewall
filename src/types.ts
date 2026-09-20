/** The three outcomes the firewall can produce. */
export type Decision = "allow" | "ask" | "block";

/**
 * Normalized agent action — every adapter translates its platform's hook
 * payload into this one shape. The core never sees platform details.
 */
export interface AgentAction {
  /** Which agent produced it: "claude-code", "codex", ... */
  agent: string;
  /** Normalized tool name: "bash", "read", "write", "webfetch", ... */
  tool: string;
  /** The shell command, file path, or URL being acted on. */
  command: string;
  /** De-obfuscated command (substitutions applied, encoded payloads decoded), set by the rules layer. */
  resolvedCommand?: string;
  cwd: string;
  sessionId?: string;
}

/**
 * One check source's opinion. Sources either short-circuit (rules) or vote
 * (the model); the decide() function owns how opinions combine.
 */
export interface Contribution {
  decision: Decision;
  /** Model confidence in its chosen decision (0..1). */
  probability?: number;
  reason: string;
  source: "rule" | "model" | "config" | "failclosed";
}

export interface FirewallVerdict {
  decision: Decision;
  contributions: Contribution[];
  latencyMs: number;
}
