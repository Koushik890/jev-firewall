import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Directory of the built package (dist/ at runtime), for package-root .env.
 */
export function packageRoot(): string {
  return path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
}

function parseEnvFile(file: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    parsed[key] = value;
  }
  return parsed;
}

/**
 * Minimal .env support so hook subprocesses (spawned by agents with a bare
 * environment) can pick up the model key wherever the hook runs.
 *
 * Candidates, lowest → highest precedence:
 *   ~/.jev-firewall/.env   (global home written by `jev-firewall setup`)
 *   <package root>/.env    (the installed package's own .env)
 *   <cwd>/.env             (project-local override)
 * Real environment variables always win over every .env value.
 */
export function loadDotEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const candidates = [
    path.join(homedir(), ".jev-firewall", ".env"),
    path.join(packageRoot(), "..", ".env"),
    path.join(process.cwd(), ".env"),
  ];
  const merged: Record<string, string> = {};
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      Object.assign(merged, parseEnvFile(file));
    } catch {
      continue;
    }
  }
  return { ...merged, ...env };
}
