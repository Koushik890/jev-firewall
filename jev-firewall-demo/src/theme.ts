// ---------------------------------------------------------------------------
// jev-firewall demo — design tokens
//
// Theme: "retro terminal, modern restraint". A phosphor-green CRT terminal
// (scanlines, blinking caret, block glyphs) dressed with the typesafe.ai
// language: near-black ink backgrounds, one warm accent, mono ASCII marks
// (∵ ✢ [b.64]), uppercase micro-labels, spaced-out small caps.
// ---------------------------------------------------------------------------

import { Easing } from "remotion";

export const COLORS = {
  ink: "#0A0B09", // near-black, warm (typesafe bg)
  panel: "#111310", // raised surface
  panelLight: "#1A1C18",
  line: "#26292240", // hairline borders
  lineStrong: "#3A3E33",
  paper: "#ECEBE4", // warm off-white (typesafe text)
  dim: "#8B8F84", // secondary text
  dimmer: "#5A5E54",
  green: "#4ADE80", // phosphor primary
  greenDim: "#22C55E80",
  greenGlow: "#4ADE8033",
  amber: "#F5A623", // typesafe warm accent
  red: "#FF5C5C",
  blue: "#7BA6FF",
} as const;

export const FONT = {
  mono: '"Geist Mono", "JetBrains Mono", "IBM Plex Mono", Consolas, monospace',
} as const;

// 30 fps master timing
export const FPS = 30;
export const S = (seconds: number) => Math.round(seconds * FPS);

// Easing presets (used with interpolate)
export const EASE = {
  out: Easing.bezier(0.16, 1, 0.3, 1),
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
};

/** Micro-label: 11–12px uppercase, letterspaced, dim — the typesafe voice. */
export const microLabel: React.CSSProperties = {
  fontFamily: FONT.mono,
  fontSize: 13,
  letterSpacing: "0.32em",
  textTransform: "uppercase",
  color: COLORS.dim,
};

/** Hairline panel: the cards of the whole video. */
export const panelStyle: React.CSSProperties = {
  background: COLORS.panel,
  border: `1px solid ${COLORS.lineStrong}`,
  borderRadius: 6,
};
