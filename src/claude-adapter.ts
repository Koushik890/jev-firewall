import type { AgentAction, Decision } from "./types.js";

/** The subset of Claude Code's PreToolUse stdin payload this adapter needs. */
export interface ClaudeHookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/** The hookSpecificOutput contract for PreToolUse decisions. */
export interface ClaudeHookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: Decision;
    permissionDecisionReason: string;
  };
}

/** Translate Claude Code's hook payload into the core's normalized action. */
export function actionFromClaude(input: ClaudeHookInput): AgentAction {
  const tool = (input.tool_name ?? "").toLowerCase();
  const toolInput = input.tool_input ?? {};
  let command = "";
  if (typeof toolInput.command === "string") {
    command = toolInput.command;
  } else if (typeof toolInput.file_path === "string") {
    command = toolInput.file_path;
  } else if (typeof toolInput.url === "string") {
    command = toolInput.url;
  } else {
    command = JSON.stringify(toolInput);
  }
  return {
    agent: "claude-code",
    tool,
    command,
    cwd: input.cwd ?? process.cwd(),
    sessionId: input.session_id,
  };
}

/** Map a core verdict onto Claude Code's response contract. */
export function claudeResponse(decision: Decision, reason: string): ClaudeHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}
