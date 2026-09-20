/**
 * Parsing for the `check` command's payload argument.
 *
 * Windows PowerShell 5.1 strips the embedded double quotes of every argument
 * it passes to a native executable, so '{"tool_name":"Bash"}' arrives at node
 * as {tool_name:Bash}. That shape cannot be safely auto-repaired (a stripped
 * value like {command:rm -rf ./build} is ambiguous), so the error explains the
 * workaround instead of guessing — the honest failure, with a way out.
 */
export function parsePayload<T = unknown>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Mangled-by-PowerShell signature: an unquoted first property name.
    if (/^\s*\{\s*[A-Za-z_$]/.test(raw)) {
      throw new Error(
        `payload is not valid JSON: ${detail}\n` +
          `  hint: your shell stripped the embedded double quotes — Windows PowerShell 5.1 does this\n` +
          `  to every argument passed to a native exe. Pipe the payload on stdin instead (quotes\n` +
          `  survive the pipe, and check falls back to stdin when no argument is given):\n` +
          `    '{"tool_name":"Bash","tool_input":{"command":"ls"},"cwd":"."}' | jev-firewall check claude\n` +
          `  or stop PowerShell from re-quoting the argument with the stop-parsing token:\n` +
          `    jev-firewall check claude --% {\\"tool_name\\":\\"Bash\\",\\"tool_input\\":{\\"command\\":\\"ls\\"},\\"cwd\\":\\".\\"}`,
      );
    }
    throw new Error(`payload is not valid JSON: ${detail}`);
  }
}
