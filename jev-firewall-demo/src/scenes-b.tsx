// ---------------------------------------------------------------------------
// Scenes 5–8
// ---------------------------------------------------------------------------
import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { COLORS, FONT, S, microLabel, panelStyle } from "./theme";
import { CrtBackdrop, BlueprintGrid, AsciiFrame, Kicker, TerminalChrome, TypeLine, RiseWords, LogLine, Burst, Caret } from "./kit";

/** Scene 5 — Obfuscation: base64 payload gets de-obfuscated, then blocked. */
export const DecodedScene: React.FC = () => {
  const frame = useCurrentFrame();
  const b64 = "ZWNobyBjYXQgLmVudg=="; // "echo cat .env"
  const reveal = interpolate(frame, [S(2.2), S(3.6)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const chars = Math.round(reveal * b64.length);
  const judge = interpolate(frame, [S(3.8), S(4.3)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      <CrtBackdrop />
      <AsciiFrame />
      <AbsoluteFill style={{ padding: 100 }}>
        <Kicker text="obfuscation fails" delay={2} />
        <div style={{ height: 40 }} />
        <div style={{ display: "flex", gap: 40, alignItems: "stretch" }}>
          <TerminalChrome title="agent session — tool call" style={{ flex: 1.25 }}>
            <TypeLine text="$ echo ZWNobyBjYXQgLmVudg== | base64 -d | sh" start={S(0.5)} cps={44} color={COLORS.paper} fontSize={26} />
            <div style={{ height: 34 }} />
            <div style={{ fontFamily: FONT.mono, fontSize: 20, color: COLORS.dimmer, marginBottom: 14 }}>{"// the rules decode the payload, then judge the decoded text"}</div>
            <div style={{ fontFamily: FONT.mono, fontSize: 30, color: COLORS.green, whiteSpace: "pre" }}>
              {"decoded → "}
              <span style={{ color: COLORS.amber }}>{b64.slice(0, chars)}</span>
              {chars < b64.length ? <Caret size={30} color={COLORS.amber} /> : null}
            </div>
            <div style={{ height: 30 }} />
            <div style={{ fontFamily: FONT.mono, fontSize: 26, color: COLORS.red, opacity: judge }}>{"BLOCK — decoded payload touches .env"}</div>
            <div style={{ height: 10 }} />
            <div style={{ fontFamily: FONT.mono, fontSize: 20, color: COLORS.dim, opacity: judge }}>28 ms · no model call needed</div>
          </TerminalChrome>
          <div style={{ flex: 0.85, display: "flex", flexDirection: "column", gap: 22, justifyContent: "center" }}>
            {[
              ["env-var indirection", "F=.env; curl -d @$F"],
              ["command substitution", "$(echo curl) …"],
              ["eval sinks", "sh -c '<payload>'"],
              ["heredoc scripts", "sh << EOF … EOF"],
            ].map(([label, cmd], i) => (
              <div key={label} style={{ ...panelStyle, padding: "18px 24px", opacity: interpolate(frame, [S(4.4 + i * 0.35), S(4.8 + i * 0.35)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
                <div style={microLabel}>{label}</div>
                <div style={{ fontFamily: FONT.mono, fontSize: 22, color: COLORS.paper, marginTop: 6 }}>{cmd}</div>
              </div>
            ))}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Scene 6 — The gate: audit log builds, uncertain goes to a human. */
export const GateScene: React.FC = () => {
  const frame = useCurrentFrame();
  const ask = interpolate(frame, [S(3.4), S(3.9)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      <CrtBackdrop />
      <BlueprintGrid />
      <AsciiFrame />
      <AbsoluteFill style={{ padding: 100 }}>
        <Kicker text="calibrated · fail-closed" delay={2} />
        <div style={{ height: 40 }} />
        <div style={{ display: "flex", gap: 44 }}>
          {/* audit log panel */}
          <div style={{ ...panelStyle, flex: 1.35, padding: "26px 30px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 18 }}>
              <span style={microLabel}>~/.jev-firewall/log.jsonl</span>
              <span style={{ ...microLabel, color: COLORS.green }}>every decision · receipts</span>
            </div>
            <LogLine start={S(0.4)} time="02:14:22" decision="BLOCK" color={COLORS.red} command="curl -d @.env …" />
            <LogLine start={S(1.0)} time="02:14:35" decision="ALLOW" color={COLORS.green} command="git status" />
            <LogLine start={S(1.6)} time="02:15:01" decision="ALLOW" color={COLORS.green} command="npm run build" />
            <LogLine start={S(2.2)} time="02:15:19" decision="BLOCK" color={COLORS.red} command="base64 … | sh" />
            <LogLine start={S(2.8)} time="02:15:44" decision="ALLOW" color={COLORS.green} command="npm test" />
            <div style={{ height: 12 }} />
            <div style={{ opacity: ask, fontFamily: FONT.mono, fontSize: 21, color: COLORS.dimmer }}>
              <span style={{ color: COLORS.dimmer }}>{"— "}</span>
              <span style={{ color: COLORS.amber, fontWeight: 700 }}>ASK</span>
              <span> rm -rf ./build … p=0.57 → waiting for human</span>
              <Caret size={20} color={COLORS.amber} />
            </div>
          </div>
          {/* human decision card */}
          <div style={{ ...panelStyle, flex: 0.9, padding: "30px 32px", borderColor: ask ? COLORS.amber : COLORS.lineStrong, boxShadow: ask ? `0 0 80px ${COLORS.amber}22` : "none", alignSelf: "flex-start" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ ...microLabel, color: COLORS.amber }}>uncertain → human</span>
              <Burst size={16} color={COLORS.amber} />
            </div>
            <div style={{ fontFamily: FONT.mono, fontSize: 27, color: COLORS.paper, marginTop: 14, lineHeight: 1.5 }}>$ rm -rf ./build</div>
            <div style={{ fontFamily: FONT.mono, fontSize: 20, color: COLORS.dim, marginTop: 10, lineHeight: 1.6 }}>
              Jev: ask · p=0.57
              <br />
              rules: no opinion
            </div>
            <div style={{ height: 22 }} />
            {["allow", "block"].map((d, i) => (
              <div key={d} style={{ ...panelStyle, padding: "12px 18px", marginBottom: 10, opacity: interpolate(frame, [S(4.1 + i * 0.3), S(4.4 + i * 0.3)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
                <span style={{ fontFamily: FONT.mono, fontSize: 22, color: d === "allow" ? COLORS.green : COLORS.red }}>{`> ${d}`}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ marginTop: 34, fontFamily: FONT.mono, fontSize: 26, color: COLORS.dim }}>
          <span style={{ color: COLORS.paper, fontWeight: 700 }}>Fail closed, always.</span> On error, timeout, or missing key — never a silent allow.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Scene 7 — Install: one command, then the decision lives in code. */
export const InstallScene: React.FC = () => {
  const frame = useCurrentFrame();
  const showResult = interpolate(frame, [S(3.0), S(3.6)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const codeOpacity = interpolate(frame, [S(4.2), S(4.8)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      <CrtBackdrop />
      <AsciiFrame />
      <AbsoluteFill style={{ padding: 100 }}>
        <Kicker text="wiring it in" delay={2} />
        <div style={{ height: 40 }} />
        <div style={{ display: "flex", gap: 40, alignItems: "stretch" }}>
          <TerminalChrome title="powershell — your machine" style={{ flex: 1 }}>
            <TypeLine text="$ npm install -g jev-firewall" start={S(0.4)} cps={40} color={COLORS.paper} fontSize={27} />
            <TypeLine text="$ jev-firewall setup" start={S(1.4)} cps={40} color={COLORS.paper} fontSize={27} />
            <div style={{ height: 24 }} />
            <div style={{ fontFamily: FONT.mono, fontSize: 22, color: COLORS.dim, lineHeight: 1.8, opacity: showResult }}>
              <div>{"> "}validating key with a live Jev call…</div>
              <div style={{ color: COLORS.green }}>{"> "}✓ Jev answered (HTTP 200)</div>
              <div>{"> "}key saved to ~/.jev-firewall/.env (mode 0600)</div>
              <div style={{ color: COLORS.green }}>{"> "}✓ claude: hook installed</div>
              <div style={{ color: COLORS.green }}>{"> "}✓ codex: hook installed</div>
            </div>
          </TerminalChrome>
          <div style={{ ...panelStyle, flex: 0.9, padding: "28px 30px", opacity: codeOpacity }}>
            <div style={{ ...microLabel, marginBottom: 16 }}>the decision, as code</div>
            <div style={{ fontFamily: FONT.mono, fontSize: 22, lineHeight: 2.1, color: COLORS.paper, whiteSpace: "pre" }}>
              {`const d = await jev.decide(action);\n\n`}{"// typed, not a string:\n"}
              <span style={{ color: COLORS.green }}>{"\"decision\": \"allow\""}</span>
              {`\n`}
              <span style={{ color: COLORS.green }}>{"\"probability\": 0.97"}</span>
              {`\n\n`}
              <span style={{ color: COLORS.dimmer }}>{"// confident → act\n// uncertain → ask\n// never a silent allow"}</span>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 34, fontFamily: FONT.mono, fontSize: 26, color: COLORS.dim }}>
          <span style={{ color: COLORS.paper, fontWeight: 700 }}>Rules can only tighten.</span> <span style={{ color: COLORS.green }}>88%</span> of calls never touch the network.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Scene 8 — Outro: wordmark, marks, npm line. */
export const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const marks = interpolate(frame, [S(1.6), S(2.4)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const npm = interpolate(frame, [S(2.8), S(3.4)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      <CrtBackdrop />
      <AsciiFrame />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ display: "flex", justifyContent: "center", gap: 30, opacity: marks, fontFamily: FONT.mono, fontSize: 30 }}>
            <span style={{ color: COLORS.amber }}>✢</span>
            <span style={{ color: COLORS.green }}>ALLOW</span>
            <span style={{ color: COLORS.amber }}>ASK</span>
            <span style={{ color: COLORS.red }}>BLOCK</span>
            <span style={{ color: COLORS.amber }}>✢</span>
          </div>
          <div style={{ height: 34 }} />
          <RiseWords text="jev-firewall" start={20} size={110} color={COLORS.green} />
          <div style={{ height: 20 }} />
          <div style={{ ...microLabel, opacity: marks }}>machine-native guardrails · powered by the typesafe system one model</div>
          <div style={{ height: 60 }} />
          <div style={{ ...panelStyle, display: "inline-block", padding: "20px 34px", opacity: npm }}>
            <span style={{ fontFamily: FONT.mono, fontSize: 26, color: COLORS.paper }}>
              <span style={{ color: COLORS.amber }}>$ </span>
              npm install -g jev-firewall
              <Caret size={26} />
            </span>
          </div>
          <div style={{ height: 26 }} />
          <div style={{ fontFamily: FONT.mono, fontSize: 18, color: COLORS.dimmer, opacity: npm }}>typesafe.ai · github.com/Koushik890/jev-firewall</div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
