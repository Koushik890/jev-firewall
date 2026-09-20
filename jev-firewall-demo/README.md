# jev-firewall demo video

An 8-scene, ~55-second Remotion video (1920×1080, 30 fps) that walks through jev-firewall:
the two-agent setup, the shell-aware rules engine, a prompt-injection attack, payload
decoding, the allow / ask / block gate, and installation.

The rendered assets are embedded in the [main README](../README.md#see-it-in-action).

## Commands

**Preview in Remotion Studio**

```console
npm i
npm run dev
```

**Render** (defaults to `out/JevFirewallDemo.mp4`; `--overwrite` skips the confirm prompt)

```console
npx remotion render JevFirewallDemo --overwrite
```

**Upgrade Remotion**

```console
npm run upgrade
```

## Publishing to the main README

The main README embeds a GIF hero (clickable, links to the MP4) from `docs/` at the repo
root — `out/` is gitignored, so published assets must live there. Render straight into it
with a small scale factor to keep the GIF size sane:

```console
npx remotion render JevFirewallDemo --overwrite --output ../docs/jev-firewall-demo.mp4
npx remotion render JevFirewallDemo --overwrite --output ../docs/jev-firewall-demo.gif --codec gif --scale 0.5
```

Then commit `docs/jev-firewall-demo.{mp4,gif}`. Keep both under ~10 MB each so the repo and
README stay fast to load.

## License

Note that for some entities a company license is needed for Remotion. [Read the terms here](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md).
