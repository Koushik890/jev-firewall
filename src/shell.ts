/**
 * Shell understanding for policy checks. Two engines, one shared processor:
 *
 *  - "grammar" (default): tree-sitter-bash parses the FULL bash language —
 *    heredocs, process substitution, command substitution — and the AST is
 *    flattened into texts (see shell-grammar.ts).
 *  - "fallback": the hand-written quote-aware splitter below, used when the
 *    wasm grammar cannot load (or via explicit request in tests).
 *
 * Shared processing on every engine's output: brace expansion, VAR=value
 * assignment tracking with $VAR/${VAR} substitution, base64/base32/xxd payload
 * decoding feeding decoders, eval-sink payload re-resolution, and an "opaque"
 * flag for commands whose payload cannot be known statically.
 *
 * Everything is pure and depth-limited (MAX_DEPTH) so hostile input cannot
 * recurse forever. This is a policy resolver, NOT a complete shell.
 */
import type { GrammarEngine, GrammarExtraction } from "./shell-grammar.js";

export interface ResolvedCommand {
  /** Resolved compound segments (substitutions applied, decoded payloads included). */
  segments: string[];
  /** Segments joined with " && " — what the model should judge. */
  resolvedText: string;
  /** Texts recovered by decoding (already included in segments/resolvedText). */
  decoded: string[];
  /** True when some payload cannot be known statically — never silently allow. */
  opaque: boolean;
  /** Which engine produced this resolution. */
  engine: "grammar" | "fallback";
}

const MAX_DEPTH = 2;
const MAX_PAYLOAD = 4096;
const SHELL_SINKS = new Set(["sh", "bash", "dash", "zsh", "ksh"]);

// ---------------------------------------------------------------------------
// Fallback engine: hand-written quote-aware splitting and tokenization.
// ---------------------------------------------------------------------------

/** Split on `;`, `|`, `&`, `&&`, `||`, and newlines — outside quotes and $(...). */
export function splitCompound(command: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;
  let depth = 0;
  const flush = () => {
    const t = cur.trim();
    if (t) segments.push(t);
    cur = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (escape) {
      cur += c;
      escape = false;
      continue;
    }
    if (c === "\\") {
      cur += c;
      escape = true;
      continue;
    }
    if (inSingle) {
      cur += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      cur += c;
      continue;
    }
    if (inDouble) {
      cur += c;
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      cur += c;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      depth++;
      cur += c;
      continue;
    }
    if (c === "`") {
      depth = depth > 0 ? depth - 1 : depth + 1;
      cur += c;
      continue;
    }
    if (c === "(") {
      depth++;
      cur += c;
      continue;
    }
    if (c === ")") {
      depth = Math.max(0, depth - 1);
      cur += c;
      continue;
    }
    if (depth === 0) {
      if (c === ";" || c === "\n" || c === "\r") {
        flush();
        continue;
      }
      if (c === "|" || c === "&") {
        const next = command[i + 1];
        if (c === "&" && next && /[0-9>]/.test(next)) {
          cur += c; // redirection like 2>&1, not a control operator
          continue;
        }
        flush();
        if (next === c) i++; // consume the twin of && or ||
        continue;
      }
    }
    cur += c;
  }
  flush();
  return segments;
}

/** Whitespace-split a segment the way a shell groups words. Quotes group and are KEPT so flattening never merges quoted words. */
export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let has = false;
  let inSingle = false;
  let inDouble = false;
  let escape = false;
  let depth = 0;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (escape) {
      cur += c;
      escape = false;
      continue;
    }
    if (c === "\\") {
      cur += c;
      escape = true;
      has = true;
      continue;
    }
    if (inSingle) {
      cur += c;
      if (c === "'") inSingle = false;
      has = true;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      cur += c;
      has = true;
      continue;
    }
    if (inDouble) {
      cur += c;
      if (c === '"') inDouble = false;
      has = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      cur += c;
      has = true;
      continue;
    }
    if (c === "$" && segment[i + 1] === "(") {
      depth++;
      cur += c;
      has = true;
      continue;
    }
    if (c === "`") {
      depth = depth > 0 ? depth - 1 : depth + 1;
      cur += c;
      has = true;
      continue;
    }
    if (c === "(") {
      depth++;
      cur += c;
      has = true;
      continue;
    }
    if (c === ")") {
      depth = Math.max(0, depth - 1);
      cur += c;
      has = true;
      continue;
    }
    if (depth === 0 && /\s/.test(c)) {
      if (has) tokens.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has) tokens.push(cur);
  return tokens;
}

// ---------------------------------------------------------------------------
// Shared processing (both engines).
// ---------------------------------------------------------------------------

/**
 * Brace expansion, shell-style: the word prefix/suffix applies to EVERY
 * expansion — `./{build,dist}` → `./build ./dist`, `-e{a,b}` → `-ea -eb`.
 * Applied textually on BOTH engines; non-comma braces are left alone.
 */
export function expandBraces(text: string): string {
  return text.replace(/(\S*)\{([^{}]*)\}(\S*)/g, (match, prefix: string, inner: string, suffix: string) => {
    if (!inner.includes(",")) return match;
    return inner
      .split(",")
      .map((part) => prefix + part + suffix)
      .join(" ");
  });
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function substitute(token: string, env: Map<string, string>): string {
  return token.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (full, braced, plain) => {
    const value = env.get(String(braced ?? plain));
    return value !== undefined ? value : full;
  });
}

/** Command word after skipping wrappers like sudo/nohup. */
function commandWord(tokens: string[]): string {
  let base = tokens[0] ?? "";
  if ((base === "sudo" || base === "nohup") && tokens.length > 1) base = tokens[1]!;
  return base;
}

function isDecoder(base: string, rest: string[]): boolean {
  if ((base === "base64" || base === "base32") && rest.some((t) => t === "-d" || t.startsWith("--decode"))) return true;
  if (base === "xxd" && rest.includes("-r")) return true;
  return false;
}

function isShellSink(base: string): boolean {
  return SHELL_SINKS.has(base);
}

/** Payload of eval sinks: `sh -c '<payload>'`, `eval <payload>`. */
function evalSinkPayload(base: string, rest: string[]): string | null {
  if (isShellSink(base)) {
    const i = rest.indexOf("-c");
    if (i >= 0 && rest[i + 1]) return stripQuotes(rest[i + 1]!);
    return null;
  }
  if (base === "eval" && rest.length > 1) return rest.slice(1).join(" ");
  return null;
}

const B64_LIKE = /^[A-Za-z0-9+/\-_]{8,}={0,2}$/;

/** Last base64-looking literal among the given segments' tokens. */
function findBase64Payload(text: string): string | null {
  for (let i = tokenize(text).length - 1; i >= 0; i--) {
    const t = stripQuotes(tokenize(text)[i]!);
    if (t.length <= MAX_PAYLOAD && B64_LIKE.test(t)) return t;
  }
  return null;
}

function decodeBase64(payload: string): string | null {
  try {
    const text = Buffer.from(payload, "base64").toString("utf8");
    if (!text) return null;
    let printable = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) printable++;
    }
    return printable / text.length >= 0.9 ? text : null;
  } catch {
    return null;
  }
}

/** Inner command text of `$(...)` and backtick substitutions in a token. */
function substitutionInners(token: string): string[] {
  const inners: string[] = [];
  let i = 0;
  while (i < token.length) {
    if (token[i] === "$" && token[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      let inner = "";
      for (; j < token.length; j++) {
        const c = token[j]!;
        if (c === "(") depth++;
        if (c === ")") {
          depth--;
          if (depth === 0) break;
        }
        if (j > i + 1) inner += c;
      }
      if (inner) inners.push(inner);
      i = j + 1;
      continue;
    }
    if (token[i] === "`") {
      const end = token.indexOf("`", i + 1);
      if (end > i) {
        inners.push(token.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return inners;
}

interface ProcessingOut {
  resolvedSegments: string[];
  decoded: string[];
  opaque: boolean;
}

/** Process raw segments: assignments, decoders, sinks, substitutions. Shared by both engines. */
async function processSegments(rawSegments: string[], env: Map<string, string>, out: ProcessingOut, depth: number, engine: GrammarEngine | null): Promise<void> {
  for (let s = 0; s < rawSegments.length; s++) {
    const seg = rawSegments[s]!;
    const tokens = tokenize(seg);

    // Leading VAR=value assignments apply to this segment and the rest of the
    // line. Values are expanded against the env seen so far (B=$A chains),
    // and stored WITHOUT quotes so `B="$A"` stores the expanded value.
    let k = 0;
    while (k < tokens.length && ASSIGNMENT.test(tokens[k]!)) {
      const m = ASSIGNMENT.exec(tokens[k]!)!;
      env.set(m[1]!, stripQuotes(substitute(m[2] ?? "", env)));
      k++;
    }
    const rest = tokens.slice(k).map((t) => substitute(t, env));
    if (rest.length === 0) continue; // pure assignment segment

    const base = commandWord(rest);

    // Decoder + payload: decode, re-resolve, and surface the decoded text.
    if (isDecoder(base, rest)) {
      const payload = findBase64Payload(rawSegments.slice(0, s + 1).join(" "));
      const text = payload ? decodeBase64(payload) : null;
      if (text) {
        out.decoded.push(text);
        if (depth < MAX_DEPTH) {
          const inner = await resolveCommand(text, depth + 1, engine);
          out.resolvedSegments.push(...inner.segments);
          out.decoded.push(...inner.decoded);
          if (inner.opaque) out.opaque = true;
        }
        if (rawSegments.slice(s + 1).some((later) => isShellSink(commandWord(tokenize(substitute(later, env)))))) out.opaque = true;
        continue;
      }
    }

    // Eval sink payloads are executable text, not strings: re-resolve them.
    const sinkPayload = evalSinkPayload(base, rest);
    if (sinkPayload !== null) {
      out.resolvedSegments.push(rest.join(" "));
      if (depth < MAX_DEPTH) {
        const inner = await resolveCommand(sinkPayload, depth + 1, engine);
        out.resolvedSegments.push(...inner.segments);
        out.decoded.push(...inner.decoded);
        if (inner.opaque) out.opaque = true;
      }
      continue;
    }

    // Substitution in command position: the effective program is unknown.
    if (base.startsWith("$(") || base.includes("`")) out.opaque = true;
    // Pipeline into a shell without a decodable payload (e.g. `curl ... | sh`).
    if (isShellSink(base) && !evalSinkPayload(base, rest)) out.opaque = true;

    out.resolvedSegments.push(rest.join(" "));

    // Inner text of substitutions in argument position is still executable somewhere.
    if (depth < MAX_DEPTH) {
      for (const token of rest) {
        for (const innerText of substitutionInners(token)) {
          const inner = await resolveCommand(innerText, depth + 1, engine);
          out.resolvedSegments.push(...inner.segments);
          out.decoded.push(...inner.decoded);
          if (inner.opaque) out.opaque = true;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Engine dispatch.
// ---------------------------------------------------------------------------

function extractionToSegments(extraction: GrammarExtraction): string[] {
  const segments: string[] = [];
  // Grammar statements can be whole pipelines: sub-split each one into
  // per-command segments so assignment/decoder/sink logic sees real commands.
  for (const statement of extraction.segments) {
    segments.push(...splitCompound(expandBraces(statement)));
  }
  for (const inner of extraction.innerTexts) {
    segments.push(...splitCompound(expandBraces(inner)));
  }
  return segments.filter((s) => s.trim() !== "");
}

/**
 * Resolve a command into the texts policy should judge.
 * Uses the grammar engine when available and working; falls back to the
 * hand-written resolver otherwise. Explicitly pass `null` to force fallback.
 */
export async function resolveCommand(command: string, depth = 0, engine?: GrammarEngine | null): Promise<ResolvedCommand> {
  const out: ProcessingOut = { resolvedSegments: [], decoded: [], opaque: false };
  const env = new Map<string, string>();

  if (engine === undefined) {
    const { loadGrammarEngine } = await import("./shell-grammar.js");
    engine = await loadGrammarEngine();
  }

  let rawSegments: string[];
  if (engine) {
    try {
      const extraction = engine.parse(command);
      for (const [name, value] of extraction.assignments) {
        env.set(name, stripQuotes(substitute(value, env)));
      }
      rawSegments = extractionToSegments(extraction);
      if (extraction.commandPositionOpaque) out.opaque = true;
    } catch {
      return resolveFallback(command, depth);
    }
  } else {
    return resolveFallback(command, depth);
  }

  await processSegments(rawSegments, env, out, depth, engine);
  return {
    segments: out.resolvedSegments,
    resolvedText: out.resolvedSegments.join(" && "),
    decoded: out.decoded,
    opaque: out.opaque,
    engine: "grammar",
  };
}

/** The hand-written path, also used as the fallback for engine failures. */
export async function resolveFallback(command: string, depth = 0): Promise<ResolvedCommand> {
  const out: ProcessingOut = { resolvedSegments: [], decoded: [], opaque: false };
  const env = new Map<string, string>();
  await processSegments(splitCompound(command).map(expandBraces), env, out, depth, null);
  return {
    segments: out.resolvedSegments,
    resolvedText: out.resolvedSegments.join(" && "),
    decoded: out.decoded,
    opaque: out.opaque,
    engine: "fallback",
  };
}
