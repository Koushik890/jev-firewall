#!/usr/bin/env node
import { createFirewall, checkAction, startClaudeHook, startCodexHook, finalReason, type HookAdapter, claudeHookAdapter, codexHookAdapter } from "./index.js";
import { actionFromClaude, type ClaudeHookInput } from "./claude-adapter.js";
import { actionFromCodex, type CodexHookInput } from "./codex-adapter.js";
import { detectAgents, installPlatform, type Platform } from "./install.js";
import { runSetup } from "./setup.js";
import { parsePayload } from "./payload.js";
import { collectStatus, formatStatus } from "./status.js";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const USAGE = `jev-firewall — a real-time firewall for AI coding agents

Setup:
  jev-firewall setup            Pick a provider (TypeSafe direct or Vercel AI Gateway),
                                validate the key, detect Claude Code/Codex, wire the hooks.
                                flags: --provider typesafe|gateway --key KEY --yes
  jev-firewall install [agent]  Wire the hook into Claude Code and/or Codex
                                (no argument: every detected agent)
  jev-firewall status           Model, key source, and per-agent hook status
  jev-firewall doctor           Live check: key → provider → one real decision

Run:
  jev-firewall check [claude|codex] '<json>'   Check one hook payload (default claude, or stdin)
  jev-firewall hook [claude|codex]             Run the PreToolUse hook loop (stdin/stdout)
  jev-firewall logs [n]                        Show the last n audit entries (default 20)

Config: jev-firewall.yaml (repo root) or ~/.jev-firewall.yaml — see jev-firewall.yaml.example
Model:  JEVD_PROVIDER=typesafe (TYPESAFE_API_KEY) | gateway (AI_GATEWAY_API_KEY) — setup writes ~/.jev-firewall/.env
Codex:  JEVD_CODEX_ASK=deny escalates every ASK to deny (fail-closed posture)
`;

function platformOf(value: string | undefined): Platform {
  return value === "codex" ? "codex" : "claude";
}

function adapterFor(platform: Platform): HookAdapter {
  if (platform === "codex") {
    return codexHookAdapter({ askAsDeny: process.env.JEVD_CODEX_ASK === "deny" });
  }
  return claudeHookAdapter;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "check": {
      const platform = platformOf(rest[0]);
      const arg = rest[0] === "claude" || rest[0] === "codex" ? rest[1] : rest[0];
      const raw = arg ?? readFileSync(0, "utf8");
      const firewall = await createFirewall();
      const payload = platform === "codex" ? parsePayload<CodexHookInput>(raw) : parsePayload<ClaudeHookInput>(raw);
      const action = platform === "codex" ? actionFromCodex(payload) : actionFromClaude(payload);
      const verdict = await checkAction(firewall, action);
      console.log(JSON.stringify(verdict, null, 2));
      console.log(finalReason(verdict));
      return verdict.decision === "block" ? 2 : 0;
    }

    case "hook": {
      const platform = platformOf(rest[0]);
      const firewall = await createFirewall();
      if (platform === "codex") {
        await startCodexHook(firewall, process.stdin, process.stdout, { askAsDeny: process.env.JEVD_CODEX_ASK === "deny" });
      } else {
        await startClaudeHook(firewall);
      }
      return 0;
    }

    case "setup":
      return runSetup({
        provider: rest.includes("--provider") ? rest[rest.indexOf("--provider") + 1] : undefined,
        key: rest.includes("--key") ? rest[rest.indexOf("--key") + 1] : undefined,
        yes: rest.includes("--yes"),
      });

    case "install": {
      const arg = rest[0];
      if (arg !== undefined && arg !== "claude" && arg !== "codex") {
        console.error('install: pass "claude" or "codex" (or nothing for every detected agent)');
        return 1;
      }
      const targets: Platform[] = arg === "claude" || arg === "codex" ? [arg] : (["claude", "codex"] as Platform[]).filter((p) => detectAgents()[p]);
      if (targets.length === 0) {
        console.error("install: no Claude Code or Codex installation detected; pass \"claude\" or \"codex\" explicitly");
        return 1;
      }
      let code = 0;
      for (const target of targets) code = Math.max(code, printInstall(target));
      return code;
    }

    case "status":
      console.log(formatStatus(collectStatus()));
      return 0;

    case "logs": {
      const n = Number(rest[0] ?? 20) || 20;
      return showLogs(n);
    }

    case "doctor": {
      const { runDoctor } = await import("./doctor.js");
      return runDoctor();
    }

    default:
      process.stdout.write(USAGE);
      return cmd ? 1 : 0;
  }
}

function printInstall(entry: Platform): number {
  const outcome = installPlatform(entry);
  if (outcome.status === "error") {
    console.error(`install: ${outcome.path} ${outcome.error}`);
    return 1;
  }
  if (outcome.status === "already") {
    console.log(`install: jev-firewall hook already present in ${outcome.path}, nothing to do`);
    return 0;
  }
  console.log(`install: wrote jev-firewall PreToolUse hook to ${outcome.path}`);
  console.log(`         hook command: ${outcome.command}`);
  if (entry === "codex") {
    console.log(`         next: run /hooks inside Codex and TRUST the jev-firewall entry —`);
    console.log(`               untrusted hooks do not run (trust is recorded per hook hash)`);
    console.log(`         optional: set JEVD_CODEX_ASK=deny to escalate every ASK to deny`);
  } else {
    console.log(`         next: restart Claude Code, then run "jev-firewall logs" to watch decisions`);
  }
  return 0;
}

async function showLogs(n: number): Promise<number> {
  const logPath = path.join(homedir(), ".jev-firewall", "log.jsonl");
  if (!existsSync(logPath)) {
    console.log("no audit log yet — decisions appear here after the first check");
    return 0;
  }
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const tail = lines.slice(-n);
  for (const line of tail) {
    try {
      const e = JSON.parse(line) as { ts: string; agent: string; decision: string; probability?: number; latencyMs: number; command: string };
      const prob = e.probability !== undefined ? ` ${(e.probability * 100).toFixed(0)}%` : "";
      console.log(`${e.ts}  ${e.agent.padEnd(11)} ${e.decision.toUpperCase().padEnd(6)}${prob}  ${String(e.latencyMs).padStart(4)}ms  ${e.command.slice(0, 90)}`);
    } catch {
      console.log(line);
    }
  }
  return 0;
}

main().then(
  (code) => {
    // process.exitCode + a natural drain, never process.exit(): tearing down
    // while undici's keep-alive sockets close trips a libuv assertion on
    // Windows ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)") and
    // corrupts the exit code (127 instead of the block→2 contract). The hook
    // entrypoint (agent-hook.ts) already exits this way; draining measured
    // no keep-alive linger.
    process.exitCode = code ?? 0;
  },
  (err) => {
    console.error("jev-firewall:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
