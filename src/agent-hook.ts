#!/usr/bin/env node
/**
 * Shared hook entrypoint for both agents: the registered command is
 *   node "<...>/agent-hook.js" claude|codex
 * so both installers point at one battle-tested script.
 */
import { createFirewall, startClaudeHook, startCodexHook } from "./index.js";

const platform = process.argv[2] ?? "claude";
const firewall = await createFirewall();

if (platform === "codex") {
  const askAsDeny = process.env.JEVD_CODEX_ASK === "deny";
  await startCodexHook(firewall, process.stdin, process.stdout, { askAsDeny });
} else {
  await startClaudeHook(firewall);
}
