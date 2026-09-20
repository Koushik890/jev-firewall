import { basename } from "node:path";
import { resolveCommand, tokenize, type ResolvedCommand } from "./shell.js";
import type { AgentAction, Contribution, FirewallVerdict } from "./types.js";
import type { FirewallConfig } from "./config.js";

/**
 * Deterministic layer — judges what a command DOES, not just what it says.
 *
 * blocked_paths regexes run coarse over raw text, the resolved line, and
 * decoded payloads (deliberately aggressive, low false-positive cost).
 * protected_files scans QUOTE-AWARE tokens, so `echo "cat .env"` — harmless
 * text — is not blocked, while `cat .env` and `tar czf x.tgz .env` are.
 *
 * Rules stay TIGHTEN-ONLY: block or delegate; the only allows are
 * user-delegated, and opaque (runtime-constructed) commands never pass
 * silently.
 */

export interface RulesResult {
  verdict: FirewallVerdict;
  /** The de-obfuscated command, for the model and the audit log. */
  resolved: ResolvedCommand;
}

/** Protected-file scan over quote-aware tokens (curl's @file syntax included). */
function protectedFileFinding(text: string, config: FirewallConfig): Contribution | null {
  for (const token of tokenize(text)) {
    const base = basename(token.replace(/^["',@]+/, "").replace(/["',]+$/, ""));
    if (config.protectedFiles.includes(base)) {
      return { decision: "block", reason: `touches protected file: ${base}`, source: "rule" };
    }
  }
  return null;
}

/**
 * echo/printf segments are print-carriers: their (possibly expanded) text is
 * OUTPUT, never file access — `echo $MSG` printing the words ".env" must not
 * block the way `cat .env` reading it does. Command substitution inside them
 * is still judged because it becomes its own resolved segment.
 */
function isPrintCarrier(segment: string): boolean {
  const head = tokenize(segment)[0];
  return head === "echo" || head === "printf";
}

export async function applyRules(action: AgentAction, config: FirewallConfig): Promise<RulesResult> {
  const resolved = await resolveCommand(action.command);
  const contributions: Contribution[] = [];

  // 1. blocked_paths regexes: raw + resolved line + decoded payloads.
  const regexTexts = [action.command, resolved.resolvedText, ...resolved.decoded];
  for (const text of regexTexts) {
    for (const pattern of config.blockedPaths) {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        contributions.push({ decision: "block", reason: `invalid blocked_paths regex: ${pattern}`, source: "failclosed" });
        continue;
      }
      if (re.test(text)) {
        contributions.push({ decision: "block", reason: `matches blocked_paths: ${pattern}`, source: "rule" });
      }
    }
  }

  // 2. protected files: per RESOLVED SEGMENT with print-carriers exempt.
  // Segments (not the raw blob) so quotes and expansions are understood;
  // decoded payloads too, since they are commands the shell will run.
  for (const text of [...resolved.segments, ...resolved.decoded]) {
    if (isPrintCarrier(text)) continue;
    const finding = protectedFileFinding(text, config);
    if (finding) contributions.push(finding);
  }

  // 3. Unknowable payloads must never pass silently: at least a human decides.
  if (resolved.opaque) {
    contributions.push({
      decision: "ask",
      reason: "payload is constructed at runtime (substitution or shell sink) — cannot be judged statically",
      source: "rule",
    });
  }

  if (contributions.some((c) => c.decision === "block")) {
    return { verdict: { decision: "block", contributions, latencyMs: 0 }, resolved };
  }

  // User-delegated allow: every segment exactly safe, nothing decoded, not
  // opaque. Trailing redirections (both `>f` and `> f`) are stripped first.
  const stripRedirect = (s: string) => s.replace(/\s*(>>?|<)\s*\S+$/, "").trim();
  const nonTrivialSegments = resolved.segments.filter((s) => stripRedirect(s) !== "");
  if (
    !resolved.opaque &&
    nonTrivialSegments.length > 0 &&
    resolved.decoded.length === 0 &&
    nonTrivialSegments.every((seg) => config.safeCommands.includes(stripRedirect(seg)))
  ) {
    return { verdict: { decision: "allow", contributions: [{ decision: "allow", reason: "user-delegated safe command", source: "config" }], latencyMs: 0 }, resolved };
  }

  // Nothing deterministic matched: hand off to the model, KEEPING every
  // contribution accumulated so far (e.g. the opaque-ask).
  contributions.push({ decision: "ask", reason: "no rule matched; model decides", source: "rule" });
  return { verdict: { decision: "ask", contributions, latencyMs: 0 }, resolved };
}
