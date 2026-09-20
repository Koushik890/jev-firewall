import type { AgentAction, Contribution } from "../types.js";
import type { DecisionModel } from "../model.js";

/**
 * Test double replicating the retired DryRunModel's layering, so pipeline
 * tests keep deterministic expectations with no network and no key:
 *   1. secret + network verb → block ~0.97
 *   2. destructive/irreversible → block ~0.92
 *   3. state-changing → ask ~0.8
 *   4. otherwise → allow ~0.95
 */
export class StubModel implements DecisionModel {
  readonly name = "stub";

  async decide(action: AgentAction): Promise<Contribution> {
    const text = action.command.toLowerCase();

    if (/(^|[^a-z0-9])(\.env|credentials\.json|id_rsa|private[_-]?key|secret|api[_-]?key|password)([^a-z0-9]|$)/.test(text) && /(curl|wget|scp|rsync|ssh|sftp|http|upload|push|post|send|fetch|transfer)/.test(text)) {
      return { decision: "block", probability: 0.97, reason: "looks like secret exfiltration (secret + network transfer)", source: "model" };
    }

    if (/(rm\s+-[rf]|rmdir|mkfs|dd\s+if=|:\(\)\{.*\}|git\s+push\s+.*--force|git\s+reset\s+--hard|drop\s+table|truncate\s+table|shred|chmod\s+-r\s*777|chown\s+-r|\beval\b)/.test(text)) {
      return { decision: "block", probability: 0.92, reason: "destructive or irreversible operation", source: "model" };
    }

    if (/(git\s+push|git\s+commit|npm\s+(install|i|publish|uninstall)|pip\s+install|brew\s+install|apt(-get)?\s+install|curl|wget|docker\s+(run|rm|rmi|system\s+prune)|kill|chmod|chown|mv\b|cp\b)/.test(text)) {
      return { decision: "ask", probability: 0.8, reason: "state-changing command worth a human glance", source: "model" };
    }

    return { decision: "allow", probability: 0.95, reason: "read-only or inspection command", source: "model" };
  }
}
