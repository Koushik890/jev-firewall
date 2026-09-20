import { test } from "node:test";
import assert from "node:assert/strict";
import { JevModel, TypeSafeJevModel, createModelFromEnv } from "../model.js";
import type { AgentAction } from "../types.js";

function action(): AgentAction {
  return { agent: "claude-code", tool: "bash", command: "git push origin main", cwd: "/repo" };
}

function fetchWith(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
}

function fetchFails(err: Error): typeof fetch {
  return (async () => {
    throw err;
  }) as unknown as typeof fetch;
}

test("jev: parses answers.decision envelope", async () => {
  const model = new JevModel({
    apiKey: "test",
    fetchImpl: fetchWith({ answers: { decision: { choice: "ask", probabilities: { allow: 0.1, ask: 0.8, block: 0.1 } } } }),
  });
  const c = await model.decide(action());
  assert.equal(c.decision, "ask");
  assert.equal(c.probability, 0.8);
  assert.ok(c.reason.includes("Jev"));
});

test("jev: parses top-level decision envelope defensively", async () => {
  const model = new JevModel({
    apiKey: "test",
    fetchImpl: fetchWith({ decision: { choice: "block", probabilities: { allow: 0.05, ask: 0.05, block: 0.9 } } }),
  });
  const c = await model.decide(action());
  assert.equal(c.decision, "block");
  assert.equal(c.probability, 0.9);
});

test("jev: unknown choice routes to ask, never acts on a foreign label", async () => {
  const model = new JevModel({
    apiKey: "test",
    fetchImpl: fetchWith({ answers: { decision: { choice: "execute", probabilities: { execute: 0.99 } } } }),
  });
  const c = await model.decide(action());
  assert.equal(c.decision, "ask");
  assert.ok(c.reason.includes("unknown choice"));
});

test("jev: HTTP error becomes a low-confidence ask with the status", async () => {
  const model = new JevModel({ apiKey: "test", fetchImpl: fetchWith({ error: { message: "nope" } }, 401) });
  const c = await model.decide(action());
  assert.equal(c.decision, "ask");
  assert.ok(c.reason.includes("401"));
});

test("jev: network failure becomes a low-confidence ask", async () => {
  const model = new JevModel({ apiKey: "test", fetchImpl: fetchFails(new Error("ECONNREFUSED")) });
  const c = await model.decide(action());
  assert.equal(c.decision, "ask");
  assert.ok(c.reason.includes("model unavailable"));
});

test("jev: timeout aborts and routes to ask", async () => {
  const slowFetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
    });
  }) as unknown as typeof fetch;
  const model = new JevModel({ apiKey: "test", fetchImpl: slowFetch, timeoutMs: 20 });
  const c = await model.decide(action());
  assert.equal(c.decision, "ask");
  assert.ok(c.reason.includes("unavailable"));
});

test("jev: request body carries model id, three criteria, and ZDR option", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const captureFetch = (async (url: unknown, init: RequestInit = {}) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ answers: { decision: { choice: "allow", probabilities: { allow: 0.9, ask: 0.05, block: 0.05 } } } }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  const model = new JevModel({ apiKey: "secret", fetchImpl: captureFetch });
  await model.decide(action());
  const cap = captured as unknown as { url: string; init: RequestInit };
  assert.ok(cap.url.endsWith("/evaluate"));
  const body = JSON.parse(String(cap.init.body)) as { model: string; questions: Record<string, { criteria: Record<string, string> }>; providerOptions: { gateway: { zeroDataRetention: boolean } } };
  assert.equal(body.model, "typesafe-ai/jev");
  assert.deepEqual(Object.keys(body.questions.decision.criteria).sort(), ["allow", "ask", "block"]);
  assert.equal(body.providerOptions.gateway.zeroDataRetention, true);
  const auth = (cap.init.headers as Record<string, string>).Authorization;
  assert.equal(auth, "Bearer secret");
});

test("jev: ZDR-denied retries without ZDR and tags the reason", async () => {
  const calls: RequestInit[] = [];
  const zdrDeniedFetch = (async (_url: unknown, init: RequestInit = {}) => {
    calls.push(init);
    if (/zeroDataRetention":\s*true/.test(String(init.body))) {
      return new Response(
        JSON.stringify({ error: { type: "permission_denied", message: "Zero Data Retention (ZDR) is only available for Pro and Enterprise plans." } }),
        { status: 403 },
      );
    }
    return new Response(JSON.stringify({ answers: { decision: { choice: "allow", probabilities: { allow: 0.9, ask: 0.05, block: 0.05 } } } }), { status: 200 });
  }) as unknown as typeof fetch;
  const model = new JevModel({ apiKey: "test", fetchImpl: zdrDeniedFetch });
  const c = await model.decide(action());
  assert.equal(c.decision, "allow");
  assert.ok(c.reason.includes("zdr:unavailable"));
  assert.equal(calls.length, 2);
  assert.ok(!String(calls[1]!.body).includes("zeroDataRetention"));
});

test("jev: zeroDataRetention:false sends no ZDR option at all", async () => {
  let body = "";
  const capture = (async (_url: unknown, init: RequestInit = {}) => {
    body = String(init.body);
    return new Response(JSON.stringify({ answers: { decision: { choice: "allow", probabilities: { allow: 0.9, ask: 0.05, block: 0.05 } } } }), { status: 200 });
  }) as unknown as typeof fetch;
  const model = new JevModel({ apiKey: "test", fetchImpl: capture, zeroDataRetention: false });
  const c = await model.decide(action());
  assert.equal(c.decision, "allow");
  assert.ok(!body.includes("zeroDataRetention"));
  assert.ok(!c.reason.includes("zdr:unavailable"));
});

test("jev: ZDR-denied is remembered, later calls skip the doomed request", async () => {
  const calls: RequestInit[] = [];
  const zdrDeniedFetch = (async (_url: unknown, init: RequestInit = {}) => {
    calls.push(init);
    if (/zeroDataRetention":\s*true/.test(String(init.body))) {
      return new Response(
        JSON.stringify({ error: { type: "permission_denied", message: "Zero Data Retention (ZDR) is only available for Pro and Enterprise plans." } }),
        { status: 403 },
      );
    }
    return new Response(JSON.stringify({ answers: { decision: { choice: "ask", probabilities: { allow: 0.1, ask: 0.8, block: 0.1 } } } }), { status: 200 });
  }) as unknown as typeof fetch;
  const model = new JevModel({ apiKey: "test", fetchImpl: zdrDeniedFetch });
  await model.decide(action());
  assert.equal(calls.length, 2);
  const c = await model.decide(action());
  assert.equal(c.decision, "ask");
  assert.equal(calls.length, 3); // one request only — ZDR failure was cached
  assert.ok(!c.reason.includes("zdr:unavailable"));
});

test("factory threads JEVD_ZDR and JEVD_HTTP_TIMEOUT_MS from env", () => {
  const model = createModelFromEnv({
    AI_GATEWAY_API_KEY: "k",
    JEVD_ZDR: "0",
    JEVD_HTTP_TIMEOUT_MS: "9000",
  }) as JevModel;
  const opts = (model as unknown as { options: { zeroDataRetention?: boolean; timeoutMs?: number } }).options;
  assert.equal(opts.zeroDataRetention, false);
  assert.equal(opts.timeoutMs, 9000);
});

test("factory: gateway keys select JevModel; TYPESAFE_API_KEY selects direct; no key → null", () => {
  assert.equal(createModelFromEnv({}), null);
  assert.equal(createModelFromEnv({ AI_GATEWAY_API_KEY: "k" })?.name, "jev");
  assert.equal(createModelFromEnv({ TYPESAFE_AI_API_KEY: "k" })?.name, "jev"); // legacy alias → gateway
  assert.equal(createModelFromEnv({ TYPESAFE_API_KEY: "k", JEVD_PROVIDER: "typesafe" })?.name, "jev-direct");
  // an explicit provider with a missing key is an honest failure, not a silent fallback
  assert.equal(createModelFromEnv({ JEVD_PROVIDER: "typesafe" }), null);
});

test("typesafe direct: posts to /v1/systemone with jev-latest and no ZDR option", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const captureFetch = (async (url: unknown, init: RequestInit = {}) => {
    captured = { url: String(url), init };
    return new Response(
      JSON.stringify({ answers: { decision: { choice: "ask", probabilities: { allow: 0.1, ask: 0.8, block: 0.1 } }, confidence: 0.8 } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const model = new TypeSafeJevModel({ apiKey: "ts_secret", fetchImpl: captureFetch });
  const c = await model.decide(action());
  assert.equal(c.decision, "ask");
  assert.equal(c.probability, 0.8);
  const cap = captured as unknown as { url: string; init: RequestInit };
  assert.ok(cap.url.endsWith("api.typesafe.ai/v1/systemone"));
  const body = JSON.parse(String(cap.init.body)) as { model: string; providerOptions?: unknown };
  assert.equal(body.model, "jev-latest");
  assert.equal(body.providerOptions, undefined);
  const auth = (cap.init.headers as Record<string, string>).Authorization;
  assert.equal(auth, "Bearer ts_secret");
});

test("typesafe direct: HTTP errors degrade to a low-confidence ask like the gateway path", async () => {
  const model = new TypeSafeJevModel({
    apiKey: "ts_secret",
    fetchImpl: (async () => new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 })) as unknown as typeof fetch,
  });
  const c = await model.decide(action());
  assert.equal(c.decision, "ask");
  assert.ok(c.reason.includes("401"));
});
