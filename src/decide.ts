import type { AgentAction, Contribution, Decision, FirewallVerdict } from "./types.js";
import type { ResolvedCommand } from "./shell.js";
import type { FirewallConfig } from "./config.js";
import type { DecisionModel } from "./model.js";
import { applyRules } from "./rules.js";

const DECISIONS: readonly Decision[] = ["allow", "ask", "block"];

function rank(d: Decision): number {
  return DECISIONS.indexOf(d);
}

/**
 * Combine a rules verdict and a model contribution into the final decision.
 *
 * Merge rules (single owner of the final call):
 *   - block wins over ask wins over allow (most restrictive wins).
 *   - Rules may only TIGHTEN: a rules "allow" is actually the user-delegated
 *     fast path and short-circuits before the model — so here, rules-block
 *     always beats any model answer.
 *   - Model allow below ask_below confidence → ask (uncertain cases go to a
 *     human). Model ask/block stand as-is.
 */
export function combine(rulesVerdict: FirewallVerdict, modelContribution: Contribution | null, askBelow: number): FirewallVerdict {
  const contributions = [...rulesVerdict.contributions];
  if (modelContribution) contributions.push(modelContribution);

  if (rulesVerdict.decision === "block") {
    return { decision: "block", contributions, latencyMs: 0 };
  }

  if (!modelContribution) {
    return { decision: rulesVerdict.decision, contributions, latencyMs: 0 };
  }

  let decision: Decision = modelContribution.decision;
  if (
    modelContribution.decision === "allow" &&
    (modelContribution.probability === undefined || modelContribution.probability < askBelow)
  ) {
    decision = "ask";
    contributions.push({
      decision: "ask",
      reason: `model confidence below ask_below (${modelContribution.probability ?? "none"} < ${askBelow})`,
      source: "config",
    });
  }

  return { decision, contributions, latencyMs: 0 };
}

/**
 * Check one action end to end: rules first, model second, merged per the
 * rules above. If ANYTHING throws (config, rules, model, bug), fail closed:
 * BLOCK — an unavailable firewall must not become an open firewall.
 */
export async function checkFull(action: AgentAction, config: FirewallConfig, model: DecisionModel | null): Promise<{ verdict: FirewallVerdict; resolved: ResolvedCommand }> {
  const started = Date.now();
  try {
    const { verdict: rulesVerdict, resolved } = await applyRules(action, config);

    // User-delegated allow short-circuits before the model.
    if (rulesVerdict.decision === "allow") {
      return { verdict: { ...rulesVerdict, latencyMs: Date.now() - started }, resolved };
    }

    // Rules-block also short-circuits: no model call for an already-blocked
    // action, and the audit reason stays the rule's, not the model's.
    if (rulesVerdict.decision === "block") {
      return { verdict: { ...rulesVerdict, latencyMs: Date.now() - started }, resolved };
    }

    let modelContribution: Contribution | null = null;
    if (config.mode === "rules" || model === null) {
      // rules-only posture, or no key configured (run `jev-firewall setup`):
      // unmatched actions go to config.default — fail closed, never open.
      modelContribution = null;
    } else {
      // The model judges the DE-OBFUSCATED command, never just the raw text.
      modelContribution = await model.decide(resolved.resolvedText ? { ...action, command: resolved.resolvedText, resolvedCommand: resolved.resolvedText } : action);
    }

    if (!modelContribution) {
      return {
        verdict: {
          decision: config.default,
          contributions: [
            ...rulesVerdict.contributions,
            {
              decision: config.default,
              reason:
                model === null
                  ? "no decision model configured — run `jev-firewall setup` (default posture applies)"
                  : "rules-only mode: no model",
              source: "config",
            },
          ],
          latencyMs: Date.now() - started,
        },
        resolved,
      };
    }

    let merged = combine(rulesVerdict, modelContribution, config.askBelow);
    // Opaque commands (payload built at runtime): a confident model allow is
    // not trustworthy evidence, so it can never produce a silent allow.
    if (resolved.opaque && merged.decision === "allow") {
      merged = {
        ...merged,
        decision: "ask",
        contributions: [...merged.contributions, { decision: "ask", reason: "opaque command: model allow not trusted, escalating to human", source: "config" }],
      };
    }
    return { verdict: { ...merged, latencyMs: Date.now() - started }, resolved };
  } catch (err) {
    return {
      verdict: {
        decision: "block",
        contributions: [{ decision: "block", reason: `firewall error, failing closed: ${String(err)}`, source: "failclosed" }],
        latencyMs: Date.now() - started,
      },
      resolved: { segments: [], resolvedText: "", decoded: [], opaque: false, engine: "fallback" },
    };
  }
}

/** check(): verdict-only view of checkFull, for simple callers. */
export async function check(action: AgentAction, config: FirewallConfig, model: DecisionModel | null): Promise<FirewallVerdict> {
  return (await checkFull(action, config, model)).verdict;
}
