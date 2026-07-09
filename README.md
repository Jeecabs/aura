# aura

A [pi](https://github.com/badlogic/pi-mono) extension that gives the input box an aura — it breathes with your music. It samples your Mac's system-audio loudness and glows the editor border in time: dim when it's quiet, laser cyan through hot pink to white-hot when it's loud.

macOS only. Everywhere else it's a silent no-op.


## Install

```bash
pi install https://github.com/Jeecabs/aura
```

If GitHub auth isn't wired into Git yet:

```bash
gh auth login
gh auth setup-git
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

The setting survives restarts — if it was on when you quit, it comes back on.


## Requirements

- **macOS.** Audio capture uses ScreenCaptureKit; the extension does nothing on other platforms.
- **A truecolor terminal.** The border only glows with 24-bit color. `/aura on` warns you if your terminal can't do it.
- **Swift toolchain** (`swiftc`, ships with Xcode / Command Line Tools). On first use it compiles a tiny helper.
- **Screen Recording permission.** ScreenCaptureKit captures system audio through the screen-recording API, so macOS will prompt for it the first time.


## How it works

On first run the extension writes a small Swift helper to a temp dir and compiles it with `swiftc` (cached by content hash, so it's a one-time cost). The helper opens a ScreenCaptureKit audio stream, computes RMS loudness per frame, and prints the dB level to stdout. The extension reads that stream and drives the glow.

System audio is heavily compressed, so a fixed dB→brightness mapping just pins the glow to white. Instead it runs an adaptive auto-gain: a slow floor and ceiling track the quiet and loud passages of whatever's playing, and each sample is mapped against that moving window. Fast attack on transients, gentle release — so the border pulses with the beat instead of flickering.

There's only one honest signal here — loudness — so it's shown as one thing: intensity. No fake spectrum.


## Layout

| File | What it does |
| --- | --- |
| `src/index.ts` | The extension: the `/aura` command, the auto-gain, and the glowing `CustomEditor`. |
| `src/system-audio.ts` | `SystemAudioSampler` — compiles and runs the Swift helper, exposes a `db()` reading. |
