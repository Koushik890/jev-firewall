// ---------------------------------------------------------------------------
// Shared retro-terminal kit: CRT backdrop, scanlines, ASCII frame, caret,
// terminal chrome. Every scene composes these so the video feels like one
// machine, shot from different angles.
// ---------------------------------------------------------------------------
import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, FONT, EASE, microLabel, panelStyle } from "./theme";

/** Blink: square wave, half period 15 frames. */
export const useBlink = (period = 30): boolean => {
  const frame = useCurrentFrame();
  return frame % period < period / 2;
};

/**
 * CRT backdrop: near-black ink, a faint phosphor vignette, scanlines and a
 * slow-rolling refresh band. Subtle — texture, not noise.
 */
export const CrtBackdrop: React.FC<{ tint?: string }> = ({ tint = COLORS.green }) => {
  const frame = useCurrentFrame();
  const { height } = useVideoConfig();
  const roll = (frame * 2) % (height + 240);
  return (
    <AbsoluteFill style={{ background: COLORS.ink }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(1200px 700px at 50% 18%, ${tint}0F 0%, transparent 60%)`,
        }}
      />
      {/* refresh band */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: roll - 240,
          height: 240,
          background: `linear-gradient(to bottom, transparent, ${tint}06, transparent)`,
        }}
      />
      {/* scanlines */}
      <AbsoluteFill
        style={{
          backgroundImage: `repeating-linear-gradient(to bottom, rgba(255,255,255,0.022) 0px, rgba(255,255,255,0.022) 1px, transparent 1px, transparent 3px)`,
        }}
      />
    </AbsoluteFill>
  );
};

/**
 * Blueprint grid (typesafe engineering texture): hairlines every 80px,
 * brighter every 4th line. Fades in; used behind diagram scenes.
 */
export const BlueprintGrid: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 25], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity }}>
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${COLORS.line} 1px, transparent 1px), linear-gradient(90deg, ${COLORS.line} 1px, transparent 1px)`,
          backgroundSize: "80px 80px",
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${COLORS.lineStrong}22 1px, transparent 1px), linear-gradient(90deg, ${COLORS.lineStrong}22 1px, transparent 1px)`,
          backgroundSize: "320px 320px",
        }}
      />
    </AbsoluteFill>
  );
};

/**
 * ASCII frame: corner ticks + edge marks, like a viewfinder on the machine.
 */
export const AsciiFrame: React.FC = () => {
  const c = COLORS.lineStrong;
  const L = 44;
  const corner: React.CSSProperties = { position: "absolute", width: L, height: L, borderColor: c, borderStyle: "solid" };
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ ...corner, top: 28, left: 28, borderWidth: "1px 0 0 1px" }} />
      <div style={{ ...corner, top: 28, right: 28, borderWidth: "1px 1px 0 0" }} />
      <div style={{ ...corner, bottom: 28, left: 28, borderWidth: "0 0 1px 1px" }} />
      <div style={{ ...corner, bottom: 28, right: 28, borderWidth: "0 1px 1px 0" }} />
      <div style={{ position: "absolute", top: 34, left: 0, right: 0, textAlign: "center", ...microLabel, fontSize: 11, color: COLORS.dimmer }}>
        ∵ jev-firewall :: machine-native guardrail ✢
      </div>
    </AbsoluteFill>
  );
};

/** Blinking block caret. */
export const Caret: React.FC<{ size?: number; color?: string }> = ({ size = 26, color = COLORS.green }) => {
  const on = useBlink();
  return <span style={{ display: "inline-block", width: size * 0.55, height: size, background: on ? color : "transparent", verticalAlign: "-0.12em" }} />;
};

/** Typesafe-style ASCII burst, used as a section mark. */
export const Burst: React.FC<{ size?: number; color?: string }> = ({ size = 22, color = COLORS.amber }) => (
  <span style={{ fontFamily: FONT.mono, color, fontSize: size }}>✢</span>
);

/** Section kicker: burst + spaced micro label. */
export const Kicker: React.FC<{ text: string; delay?: number }> = ({ text, delay = 0 }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [delay, delay + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, opacity }}>
      <Burst size={20} />
      <span style={microLabel}>{text}</span>
    </div>
  );
};

/** Terminal window chrome: dot lights + title. */
export const TerminalChrome: React.FC<{ title: string; children: React.ReactNode; style?: React.CSSProperties }> = ({ title, children, style }) => (
  <div style={{ ...panelStyle, boxShadow: `0 30px 80px ${COLORS.greenGlow}`, overflow: "hidden", ...style }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 18px", borderBottom: `1px solid ${COLORS.lineStrong}`, background: COLORS.panelLight }}>
      {["#3A3E33", "#3A3E33", COLORS.amber].map((c, i) => (
        <div key={i} style={{ width: 11, height: 11, borderRadius: 99, background: c }} />
      ))}
      <span style={{ ...microLabel, marginLeft: 10, fontSize: 11 }}>{title}</span>
    </div>
    <div style={{ padding: "26px 30px" }}>{children}</div>
  </div>
);

/** One terminal line with a typed-reveal effect. */
export const TypeLine: React.FC<{ text: string; start: number; cps?: number; color?: string; prefix?: string; fontSize?: number }> = ({
  text,
  start,
  cps = 60,
  color = COLORS.paper,
  prefix,
  fontSize = 26,
}) => {
  const frame = useCurrentFrame();
  const chars = Math.floor(interpolate(frame, [start, start + text.length / cps], [0, text.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const done = chars >= text.length;
  return (
    <div style={{ fontFamily: FONT.mono, fontSize, color, whiteSpace: "pre", lineHeight: 1.55 }}>
      {prefix ? <span style={{ color: COLORS.dim }}>{prefix}</span> : null}
      {text.slice(0, chars)}
      {!done && chars > 0 ? <Caret size={fontSize} /> : null}
      {done && prefix === "$ " ? <Caret size={fontSize} /> : null}
    </div>
  );
};

/** Staggered word rise-in for headlines. */
export const RiseWords: React.FC<{ text: string; start?: number; stagger?: number; size?: number; color?: string; weight?: number }> = ({
  text,
  start = 0,
  stagger = 3,
  size = 92,
  color = COLORS.paper,
  weight = 500,
}) => {
  const frame = useCurrentFrame();
  const words = text.split(" ");
  return (
    <div style={{ display: "flex", flexWrap: "wrap", columnGap: size * 0.28 }}>
      {words.map((w, i) => {
        const t0 = start + i * stagger;
        const p = interpolate(frame, [t0, t0 + 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE.out });
        return (
          <span
            key={i}
            style={{
              fontFamily: FONT.mono,
              fontSize: size,
              fontWeight: weight,
              color,
              letterSpacing: "-0.02em",
              transform: `translateY(${(1 - p) * 46}px)`,
              opacity: p,
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

/** Log line that slides in (audit trail effect). */
export const LogLine: React.FC<{ start: number; time: string; decision: string; color: string; command: string }> = ({ start, time, decision, color, command }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [start, start + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE.out });
  return (
    <div
      style={{
        display: "flex",
        gap: 18,
        fontFamily: FONT.mono,
        fontSize: 21,
        lineHeight: 1.7,
        opacity: p,
        transform: `translateX(${(1 - p) * 24}px)`,
      }}
    >
      <span style={{ color: COLORS.dimmer }}>{time}</span>
      <span style={{ color, fontWeight: 700, width: 64 }}>{decision}</span>
      <span style={{ color: COLORS.dim }}>{command}</span>
    </div>
  );
};
