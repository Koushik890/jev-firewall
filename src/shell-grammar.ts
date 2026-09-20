/**
 * Grammar engine for shell.ts, backed by tree-sitter-bash (web-tree-sitter,
 * wasm). Understands the whole bash language — heredocs, process
 * substitution, and brace-heavy syntax included — where the hand-written
 * regex resolver only knows the tricks it was taught.
 *
 * Loading: web-tree-sitter's ESM entry is broken under Node, so the CJS entry
 * is required explicitly via createRequire, and Parser.init() must run before
 * Language.load. Any failure (wasm missing, init throws) resolves to null and
 * the caller falls back to the hand-written resolver.
 *
 * Extraction is deliberately shallow: it turns the AST into TEXTS (command
 * segments, heredoc bodies, substitution inners, assignments) and hands them
 * to shell.ts's shared processing (env resolution, decoders, sinks). The
 * grammar engine is a better SEGMENTER, not a different policy.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { Node as TSNode } from "web-tree-sitter";

export interface GrammarExtraction {
  /** VAR=value assignments at program level, in order. */
  assignments: Array<[string, string]>;
  /** Texts of executable units: commands, pipelines, lists, subshells, redirects. */
  segments: string[];
  /** Inner texts of heredoc bodies, process/command substitutions. */
  innerTexts: string[];
  /** A substitution sits in COMMAND position: the effective program is unknown. */
  commandPositionOpaque: boolean;
}

export interface GrammarEngine {
  parse(text: string): GrammarExtraction;
}

const SEGMENT_TYPES = new Set([
  "command",
  "pipeline",
  "list",
  "subshell",
  "redirected_statement",
  "negated_command",
  "function_definition",
  "if_statement",
  "for_statement",
  "while_statement",
  "until_statement",
  "case_statement",
]);

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

function extract(root: TSNode): GrammarExtraction {
  const out: GrammarExtraction = { assignments: [], segments: [], innerTexts: [], commandPositionOpaque: false };

  const walk = (node: TSNode, isTop: boolean): void => {
    if (node.type === "heredoc_body") {
      out.innerTexts.push(node.text);
    } else if (node.type === "process_substitution") {
      // <(cmd), >(cmd): strip the wrapper, keep the inner command.
      const inner = node.text.replace(/^\s*[<>]{1,2}\(/, "").replace(/\)\s*$/, "");
      if (inner) out.innerTexts.push(inner);
    } else if (node.type === "command_substitution") {
      const inner = node.text.replace(/^\$\(\{?\s*/, "").replace(/\s*\}?\)$/, "");
      if (inner) out.innerTexts.push(inner);
    } else if (isTop && SEGMENT_TYPES.has(node.type)) {
      out.segments.push(node.text);
      // Command position: a command whose first named child is a substitution
      // (no literal command_name) means the program itself is computed.
      const first = node.type === "command" ? node.namedChildren[0] : undefined;
      if (first && (first.type === "command_substitution" || first.type === "variable_value")) {
        out.commandPositionOpaque = true;
      }
    } else if (isTop && node.type === "variable_assignment") {
      const m = ASSIGNMENT.exec(node.text);
      if (m) out.assignments.push([m[1]!, m[2]!]);
    }
    for (const child of node.namedChildren) walk(child, false);
  };

  for (const child of root.namedChildren) walk(child, true);
  return out;
}

let enginePromise: Promise<GrammarEngine | null> | null = null;

/** Lazily load the wasm grammar; null when unavailable (caller falls back). */
export function loadGrammarEngine(): Promise<GrammarEngine | null> {
  enginePromise ??= (async () => {
    try {
      const require = createRequire(import.meta.url);
      const { Parser, Language } = require("web-tree-sitter") as typeof import("web-tree-sitter");
      await Parser.init();
      const wasm: Buffer = readFileSync(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm"));
      const language = await Language.load(new Uint8Array(wasm));
      const parser = new Parser();
      parser.setLanguage(language);
      return {
        parse: (text: string) => {
          const tree = parser.parse(text);
          if (!tree) throw new Error("grammar parse failed");
          return extract(tree.rootNode);
        },
      };
    } catch {
      return null;
    }
  })();
  return enginePromise;
}

/** Test helper: force-reload the engine on the next resolve. */
export function resetGrammarEngine(): void {
  enginePromise = null;
}
