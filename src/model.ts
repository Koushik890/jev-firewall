import type { AgentAction, Contribution, Decision } from "./types.js";

/**
 * The model contract: given a normalized action, return ONE decision from a
 * fixed set, with a calibrated probability. Implementations must never throw
 * for model-side problems — they return a low-confidence contribution and let
 * decide() route the case to a human.
 */
export interface DecisionModel {
  readonly name: string;
  decide(action: AgentAction): Promise<Contribution>;
}

// ---------------------------------------------------------------------------
// Jev — the real decision model, reachable over two provider seams:
//   1. Vercel AI Gateway (default): model id `typesafe-ai/jev`, POST /v1/evaluate
//   2. TypeSafe direct:             model id `jev-latest`,        POST /v1/systemone
// Both speak the same state+questions request and the same answers envelope;
// they differ in URL, model id, and the gateway-only zero-data-retention option.
// ---------------------------------------------------------------------------

const GATEWAY_BASE = "https://ai-gateway.vercel.sh/v1";
const TYPESAFE_BASE = "https://api.typesafe.ai/v1";
const GATEWAY_MODEL_ID = "typesafe-ai/jev";
const TYPESAFE_MODEL_ID = "jev-latest";

const DECISIONS: readonly Decision[] = ["allow", "ask", "block"];

export interface JevModelOptions {
  apiKey: string;
  baseUrl?: string;
  modelId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Request zero data retention (gateway only; default true, JEVD_ZDR=0 disables).
   *  ZDR needs Vercel Pro/Enterprise — the model retries without it and tags
   *  the reason `zdr:unavailable`. */
  zeroDataRetention?: boolean;
}

/** The single question both providers answer. Same shape over either seam. */
const QUESTIONS = {
  decision: {
    type: "choice",
    instructions:
      "You are the decision engine of a firewall guarding a developer machine against an AI coding agent. Classify this tool call.",
    criteria: {
      allow: "Read-only or clearly safe and reversible: inspection, builds, tests, git status/log/diff.",
      ask: "State-changing or uncertain: installs, pushes, network writes, file mutations a cautious engineer would double-check.",
      block: "Destructive, irreversible, exfiltrates secrets or credentials, or clearly malicious.",
    },
  },
} as const;

interface EvaluateResponse {
  answers?: Record<string, { choice?: string; probabilities?: Record<string, number> }>;
  // Some envelopes may put the answer at the top level instead; parse defensively.
  decision?: { choice?: string; probabilities?: Record<string, number> };
  error?: { message?: string };
}

/** Unavailable/ambiguous model answers route to a human, never throw. */
function askContribution(reason: string): Contribution {
  return { decision: "ask", probability: 0, reason, source: "model" };
}

abstract class BaseJevModel implements DecisionModel {
  abstract readonly name: string;
  protected readonly baseUrl: string;
  protected readonly modelId: string;
  protected readonly fetchImpl: typeof fetch;
  protected readonly timeoutMs: number;
  protected readonly zdr: boolean;
  /** Remembered once the provider rejects ZDR; later calls skip the doomed request. */
  private zdrUnsupported = false;

  constructor(protected readonly options: JevModelOptions) {
    this.baseUrl = (options.baseUrl ?? this.defaultBaseUrl()).replace(/\/$/, "");
    this.modelId = options.modelId ?? this.defaultModelId();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? Number(process.env.JEVD_HTTP_TIMEOUT_MS ?? 5000);
    this.zdr = this.supportsZdr()
      ? (options.zeroDataRetention ?? (process.env.JEVD_ZDR ?? "1").trim() !== "0")
      : false;
  }

  protected abstract defaultBaseUrl(): string;
  protected abstract defaultModelId(): string;
  protected abstract supportsZdr(): boolean;
  protected abstract evaluatePath(): string;
  protected abstract extraBody(zdr: boolean): Record<string, unknown>;

  async decide(action: AgentAction): Promise<Contribution> {
    const state = [
      `agent: ${action.agent}`,
      `tool: ${action.tool}`,
      `cwd: ${action.cwd}`,
      `command: ${action.command}`,
    ].join("\n");

    const post = (zdr: boolean) => {
      // AbortController + cleared timer instead of AbortSignal.timeout: the
      // latter leaves a live timer handle that trips a libuv assertion when
      // the short-lived hook process exits on Windows.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
      const p = this.fetchImpl(`${this.baseUrl}/${this.evaluatePath()}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.modelId, state, questions: QUESTIONS, ...this.extraBody(zdr) }),
        signal: controller.signal,
      });
      void p.finally(() => clearTimeout(timer)).catch(() => {});
      return p;
    };

    try {
      const wantZdr = this.zdr && !this.zdrUnsupported;
      let res = await post(wantZdr);
      let zdrNote = "";
      if (!res.ok && wantZdr) {
        const detail = await res.text().catch(() => "");
        if (/zero data retention/i.test(detail)) {
          // ZDR needs Vercel Pro/Enterprise; falling back to default retention
          // beats blinding the firewall. The tag keeps the audit trail honest.
          this.zdrUnsupported = true;
          res = await post(false);
          zdrNote = "zdr:unavailable; ";
        } else {
          return askContribution(`model HTTP ${res.status}${detail ? `: ${detail.slice(0, 120)}` : ""}`);
        }
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return askContribution(`model HTTP ${res.status}${detail ? `: ${detail.slice(0, 120)}` : ""}`);
      }
      const data = (await res.json()) as EvaluateResponse;
      const answer = data.answers?.decision ?? data.decision;
      const choice = answer?.choice;
      const probabilities = answer?.probabilities;
      if (!choice || !probabilities || typeof probabilities[choice] !== "number") {
        return askContribution("model returned an unexpected response shape");
      }
      if (!DECISIONS.includes(choice as Decision)) {
        return askContribution(`model returned unknown choice "${choice}"`);
      }
      const probability = probabilities[choice]!;
      return {
        decision: choice as Decision,
        probability,
        reason: `${zdrNote}Jev chose ${choice} (p=${probability.toFixed(2)})`,
        source: "model",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return askContribution(`model unavailable: ${msg.slice(0, 120)}`);
    }
  }
}

/** Jev via the Vercel AI Gateway — the original seam, with the ZDR option. */
export class JevModel extends BaseJevModel {
  readonly name = "jev";
  protected defaultBaseUrl(): string {
    return GATEWAY_BASE;
  }
  protected defaultModelId(): string {
    return GATEWAY_MODEL_ID;
  }
  protected supportsZdr(): boolean {
    return true;
  }
  protected evaluatePath(): string {
    return "evaluate";
  }
  protected extraBody(zdr: boolean): Record<string, unknown> {
    // Commands can contain secrets; request zero data retention per call.
    return zdr ? { providerOptions: { gateway: { zeroDataRetention: true } } } : {};
  }
}

/** Jev direct from TypeSafe (keys from console.typesafe.ai) — no ZDR field exists here. */
export class TypeSafeJevModel extends BaseJevModel {
  readonly name = "jev-direct";
  protected defaultBaseUrl(): string {
    return TYPESAFE_BASE;
  }
  protected defaultModelId(): string {
    return TYPESAFE_MODEL_ID;
  }
  protected supportsZdr(): boolean {
    return false;
  }
  protected evaluatePath(): string {
    return "systemone";
  }
  protected extraBody(): Record<string, unknown> {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Selection: which provider, from which key, or none at all.
// ---------------------------------------------------------------------------

export type Provider = "gateway" | "typesafe";

export type ModelSelection =
  | { provider: Provider; key: string; model: DecisionModel }
  | { provider: "none"; reason: string };

/**
 * Shared selection logic for the factory, `status`, `doctor`, and `setup`:
 *   1. JEVD_PROVIDER=gateway|typesafe wins (explicit choice).
 *   2. Otherwise a TYPESAFE_API_KEY implies direct; any gateway key implies
 *      the gateway (TYPESAFE_AI_API_KEY remains a legacy gateway alias).
 *   3. No key at all → no model: unmatched actions fall back to the configured
 *      default posture (fail closed), and `jev-firewall setup` fixes the gap.
 */
export function selectModelFromEnv(env: NodeJS.ProcessEnv = process.env): ModelSelection {
  const explicit = (env.JEVD_PROVIDER ?? "").trim().toLowerCase();
  const provider: Provider =
    explicit === "typesafe" ? "typesafe"
    : explicit === "gateway" || explicit === "vercel" ? "gateway"
    : env.TYPESAFE_API_KEY
      ? "typesafe"
      : "gateway";

  const timeoutMs = env.JEVD_HTTP_TIMEOUT_MS ? Number(env.JEVD_HTTP_TIMEOUT_MS) : undefined;

  if (provider === "typesafe") {
    const key = env.TYPESAFE_API_KEY ?? env.TYPESAFE_AI_API_KEY;
    if (!key) {
      const note = env.AI_GATEWAY_API_KEY ? " (an AI_GATEWAY_API_KEY is set — unset JEVD_PROVIDER to use the gateway)" : "";
      return { provider: "none", reason: `JEVD_PROVIDER=typesafe but no TYPESAFE_API_KEY${note}` };
    }
    return {
      provider,
      key,
      model: new TypeSafeJevModel({ apiKey: key, baseUrl: env.JEVD_BASE_URL, modelId: env.JEVD_MODEL_ID, timeoutMs }),
    };
  }

  const key = env.AI_GATEWAY_API_KEY ?? env.TYPESAFE_AI_API_KEY;
  if (!key) {
    return { provider: "none", reason: "no model key configured (run `jev-firewall setup`, or set AI_GATEWAY_API_KEY)" };
  }
  return {
    provider,
    key,
    model: new JevModel({
      apiKey: key,
      baseUrl: env.JEVD_BASE_URL,
      modelId: env.JEVD_MODEL_ID,
      timeoutMs,
      // .env values only reach us through `env` (loadDotEnv never touches
      // process.env), so thread the knobs explicitly.
      zeroDataRetention: env.JEVD_ZDR !== undefined ? env.JEVD_ZDR.trim() !== "0" : undefined,
    }),
  };
}

/**
 * Pick the model from env. Returns null when no key is configured — callers
 * then fall back to the rules-only posture (never an open firewall).
 */
export function createModelFromEnv(env: NodeJS.ProcessEnv = process.env): DecisionModel | null {
  const sel = selectModelFromEnv(env);
  return sel.provider === "none" ? null : sel.model;
}
