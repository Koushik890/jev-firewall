// ---------------------------------------------------------------------------
// jev-firewall demo — 8 scenes, 1660 frames @ 30fps (~55s), 1920×1080
// ---------------------------------------------------------------------------
import React from "react";
import { AbsoluteFill, Composition, Sequence, interpolate, useCurrentFrame } from "remotion";
import { COLORS } from "./theme";

import { TitleScene, ColdOpenScene, EngineScene, AttackScene } from "./scenes-a";
import { DecodedScene, GateScene, InstallScene, OutroScene } from "./scenes-b";

/** Hard cut between scenes (with a 6-frame dip-to-black at the fold). */
export const Cut: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const fadeIn = interpolate(frame, [0, 6], [0, 1], { extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: fadeIn }}>{children}</AbsoluteFill>;
};

/** Master scene: everything composes inside this for a single <Composition>. */
export const JevFirewallDemo: React.FC = () => {
  const scenes: Array<[number, React.FC]> = [
    [0, TitleScene], //        0–150
    [150, ColdOpenScene], //   5.0–12.0s
    [360, EngineScene], //     12.0–19.0s
    [570, AttackScene], //     19.0–25.5s
    [765, DecodedScene], //    25.5–33.0s
    [990, GateScene], //       33.0–40.5s
    [1215, InstallScene], //   40.5–47.5s
    [1425, OutroScene], //     47.5–55.33s
  ];
  return (
    <AbsoluteFill style={{ background: COLORS.ink }}>
      {scenes.map(([from, Scene]) => (
        <Sequence key={from} from={from} durationInFrames={1660 - from}>
          <Cut>
            <Scene />
          </Cut>
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

export const JevFirewallDemoComposition: React.FC = () => {
  return (
    <Composition
      id="JevFirewallDemo"
      component={JevFirewallDemo}
      durationInFrames={1660}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
