# aura

A [pi](https://github.com/badlogic/pi-mono) extension that gives the input frame an aura. It breathes with your music. It samples your Mac's system-audio loudness and glows the frame in time: dim when it's quiet, laser cyan through hot pink to white-hot when it's loud.

It works on stock pi with no other extensions. It does not replace the editor. Status colors and editor content stay untouched.

<p align="center">
  <img src="demo.gif" alt="The pi input frame glowing cyan and pink in time with music">
</p>

macOS only. Everywhere else it's a silent no-op.


## Install

```bash
pi install https://github.com/Jeecabs/aura
```

### Local development

```bash
git clone https://github.com/Jeecabs/aura.git ~/.pi/agent/extensions/aura
cd ~/.pi/agent/extensions/aura
pnpm install
```

Reload pi if it's already running:

```text
/reload
```


## Use

```text
/aura          toggle the aura on/off
/aura on
/aura off
/aura status   show state and the current dB reading
```

The setting survives restarts. If it was on when you quit, it comes back on.


## Editor compatibility

Aura changes editor rendering only. On stock pi it supplies a compact rounded frame. If another extension already installed a custom editor, Aura wraps that editor and colors only the frame glyphs, so its input and status behavior stay intact.


## Requirements

- **Pi 0.84.x.** Editor wrapping and inter-extension decoration use the Pi 0.84 editor API.
- **macOS.** Audio capture uses ScreenCaptureKit; the extension does nothing on other platforms.
- **A truecolor terminal.** The frame only glows with 24-bit color. `/aura on` warns you if your terminal can't do it.
- **Swift toolchain** (`swiftc`, ships with Xcode / Command Line Tools). On first use it compiles a tiny helper.
- **Screen Recording permission.** ScreenCaptureKit captures system audio through the screen-recording API, so macOS will prompt for it the first time.


## How it works

On first run the extension writes a small Swift helper to a temp dir and compiles it with `swiftc` (cached by content hash, so it's a one-time cost). The helper opens a ScreenCaptureKit audio stream, computes RMS loudness per frame, and prints the dB level to stdout. The extension reads that stream and drives the glow.

System audio is heavily compressed, so a fixed dB→brightness mapping just pins the glow to white. Instead it runs an adaptive auto-gain: a slow floor and ceiling track the quiet and loud passages of whatever's playing, and each sample is mapped against that moving window. Fast attack on transients, gentle release, so the frame pulses with the beat instead of flickering.

There's only one honest signal here, loudness, so it's shown as one thing: intensity. No fake spectrum.


## Layout

| File | What it does |
| --- | --- |
| `src/index.ts` | The extension: `/aura`, auto-gain, and editor wrapping. |
| `src/editor-chrome.ts` | The shared rounded frame shape and frame-only glow renderer. |
| `src/system-audio.ts` | `SystemAudioSampler`, compiles and runs the Swift helper, exposes a `db()` reading. |
