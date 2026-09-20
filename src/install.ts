import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Hook registration into agent settings files. Pure functions over a JSON
 * document so tests can exercise them without touching the home directory.
 *
 * Idempotence: if a jev-firewall entry already exists, the document is
 * returned unchanged. A "clean upgrade" requires explicit removal by hand.
 */

/** Marker every jev-firewall hook command carries, for idempotence checks. */
export const MARKER = "jev-firewall";

export type Platform = "claude" | "codex";

export function settingsPathFor(entry: Platform, home: string = homedir()): string {
  return entry === "claude" ? path.join(home, ".claude", "settings.json") : path.join(home, ".codex", "hooks.json");
}

/**
 * Shell-agnostic hook command. One entrypoint script (agent-hook.js) serves
 * both platforms; the platform name is argv[2]. The script path is always
 * double-quoted so install paths with spaces survive cmd.exe and POSIX sh.
 *
 * The trailing `# jev-firewall` comment is the idempotence marker: it must
 * live in the command itself, because the install path (clone directory
 * name) is not under our control. POSIX shells drop the comment; cmd.exe
 * passes `#` and `jev-firewall` as extra argv, which agent-hook.js ignores.
 */
export function hookCommandFor(entry: "claude" | "codex"): string {
  const script = path.resolve(import.meta.dirname, "agent-hook.js");
  return `node "${script}" ${entry} # ${MARKER}`;
}

export interface HookRegistrationResult {
  doc: Record<string, unknown>;
  /** true when a jev-firewall entry was already present and nothing changed */
  alreadyInstalled: boolean;
  changed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function containsMarker(value: unknown): boolean {
  return JSON.stringify(value).includes(MARKER);
}

/**
 * Register into Claude Code's ~/.claude/settings.json document:
 * hooks.PreToolUse[] entries of shape { hooks: [{ type: "command", command }] }.
 */
export function registerClaudeHook(doc: Record<string, unknown>, command: string): HookRegistrationResult {
  const hooks = isRecord(doc.hooks) ? doc.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : [];

  if (preToolUse.some(containsMarker)) {
    return { doc, alreadyInstalled: true, changed: false };
  }
  preToolUse.push({ hooks: [{ type: "command", command }] });
  const nextHooks = { ...hooks, PreToolUse: preToolUse };
  return { doc: { ...doc, hooks: nextHooks }, alreadyInstalled: false, changed: true };
}

/**
 * Register into Codex's ~/.codex/hooks.json document:
 * { hooks: { PreToolUse: [{ command }] } }.
 */
export function registerCodexHook(doc: Record<string, unknown>, command: string): HookRegistrationResult {
  const hooks = isRecord(doc.hooks) ? doc.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : [];

  if (preToolUse.some(containsMarker)) {
    return { doc, alreadyInstalled: true, changed: false };
  }
  preToolUse.push({ command });
  const nextHooks = { ...hooks, PreToolUse: preToolUse };
  return { doc: { ...doc, hooks: nextHooks }, alreadyInstalled: false, changed: true };
}

// ---------------------------------------------------------------------------
// Detection + real installation (shared by `setup`, `install`, and `status`).
// ---------------------------------------------------------------------------

/** True when `bin` (or a Windows extension variant) is on PATH. */
export function onPath(bin: string, pathEnv: string | undefined = process.env.PATH): boolean {
  if (!pathEnv) return false;
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  return pathEnv.split(process.platform === "win32" ? ";" : ":").some((dir) => {
    if (!dir) return false;
    return exts.some((ext) => {
      try {
        return existsSync(path.join(dir, bin + ext));
      } catch {
        return false;
      }
    });
  });
}

/** Detect which supported agents are installed on this machine. */
export function detectAgents(
  home: string = homedir(),
  pathEnv: string | undefined = process.env.PATH,
): { claude: boolean; codex: boolean } {
  return {
    claude: existsSync(path.join(home, ".claude")) || onPath("claude", pathEnv),
    codex: existsSync(path.join(home, ".codex")) || onPath("codex", pathEnv),
  };
}

export interface InstallOutcome {
  status: "installed" | "already" | "error";
  path: string;
  command: string;
  error?: string;
}

/** Register the PreToolUse hook into the agent's real settings file. */
export function installPlatform(entry: Platform, home: string = homedir()): InstallOutcome {
  const settingsPath = settingsPathFor(entry, home);
  const command = hookCommandFor(entry);

  let doc: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      doc = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      return { status: "error", path: settingsPath, command, error: "not valid JSON; fix it manually and re-run" };
    }
  }

  const result = entry === "claude" ? registerClaudeHook(doc, command) : registerCodexHook(doc, command);
  if (result.alreadyInstalled) {
    return { status: "already", path: settingsPath, command };
  }
  try {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(result.doc, null, 2) + "\n", "utf8");
  } catch (err) {
    return { status: "error", path: settingsPath, command, error: err instanceof Error ? err.message : String(err) };
  }
  return { status: "installed", path: settingsPath, command };
}
