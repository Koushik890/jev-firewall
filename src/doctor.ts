/**
 * `jev-firewall doctor` — live verification of the configured model, for
 * either provider. Replaces the gateway-only jev-ping. Prints each step and
 * what to do next on failure; exits non-zero when the model cannot answer.
 */
import { loadDotEnv } from "./dotenv.js";
import { selectModelFromEnv } from "./model.js";
import type { AgentAction } from "./types.js";

export async function runDoctor(): Promise<number> {
  const env = loadDotEnv();
  const sel = selectModelFromEnv(env);

  if (sel.provider === "none") {
    console.error(`model: not configured — ${sel.reason}`);
    console.error("fix:   jev-firewall setup");
    return 1;
  }

  console.log(`1. key: present (${sel.provider})`);

  const sample: AgentAction = { agent: "claude-code", tool: "bash", command: "git push origin main", cwd: "/repo" };
  console.log("2. evaluate: asking Jev to classify `git push origin main`…");
  const contribution = await sel.model.decide(sample);

  if (contribution.decision === "ask" && contribution.probability === 0) {
    // The model's fail-closed answer carries the reason it could not answer.
    console.error(`3. model did not answer: ${contribution.reason}`);
    if (/credit card|customer_verification_required/i.test(contribution.reason)) {
      console.log("→ your key is valid but the provider account needs a credit card on file");
      console.log("  (provider dashboard → billing), then re-run.");
    }
    return 1;
  }

  console.log(`3. decision: ${JSON.stringify(contribution)}`);
  console.log(`\nJev is LIVE via ${sel.provider} (${sel.model.name}) — hooks will use it for every unmatched action.`);
  return 0;
}

// Invoked directly: node dist/doctor.js (or: npm run doctor)
if (process.argv[1] && /doctor\.[cm]?js$/.test(process.argv[1])) {
  // Drain naturally (see cli.ts): process.exit() during undici teardown trips
  // a libuv assertion on Windows and replaces the exit code with 127.
  runDoctor().then((code) => {
    process.exitCode = code;
  });
}
