import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { SystemAudioSampler } from "./system-audio.js";

// ─── Aura ────────────────────────────────────────────────────────
//
// We only have one signal from system audio: loudness. The honest way to show a
// single scalar is intensity — so we glow the input box's border, brightening and
// shifting colour with the volume, instead of faking a spectrum. macOS only.

const STATE_TYPE = "aura-state";
const FRAME_MS = 90;

// Loudness → colour: dim idle → laser cyan → hot pink → white-hot.
const GLOW_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[72, 62, 104],
	[55, 232, 255],
	[255, 113, 206],
	[255, 232, 248],
];

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const stripSgr = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

function glowFg(intensity: number): string {
	const t = clamp(intensity, 0, 1);
	const seg = t * (GLOW_STOPS.length - 1);
	const i = Math.min(GLOW_STOPS.length - 2, Math.floor(seg));
	const u = seg - i;
	const a = GLOW_STOPS[i]!;
	const b = GLOW_STOPS[i + 1]!;
	const r = Math.round(a[0] + (b[0] - a[0]) * u);
	const g = Math.round(a[1] + (b[1] - a[1]) * u);
	const bl = Math.round(a[2] + (b[2] - a[2]) * u);
	return `\x1b[38;2;${r};${g};${bl}m`;
}

// A border rule is a line that's mostly box-drawing horizontals (full rule or a
// "─── ↑ N more ───" scroll indicator). Content/prompt lines never qualify.
function isBorderRule(line: string): boolean {
	const raw = stripSgr(line).trim();
	if (raw.length < 3) return false;
	let dashes = 0;
	for (const ch of raw) if (ch === "─") dashes++;
	return dashes >= raw.length * 0.5;
}

class GlowEditor extends CustomEditor {
	private timer?: ReturnType<typeof setInterval>;
	private glow = 0; // smoothed, auto-gained loudness, 0..1
	// Adaptive auto-gain. System audio is heavily compressed (measured ~−24…−16 dB), so a
	// fixed dB→level window pins the glow to white. Instead, track a slow floor/ceiling and
	// map each sample against that — adapts to any track/volume and uses the full range.
	private floorDb = -40;
	private ceilDb = -16;

	constructor(
		private readonly getDb: () => number,
		private readonly getActive: () => boolean,
		private readonly truecolor: boolean,
		...args: ConstructorParameters<typeof CustomEditor>
	) {
		super(...args);
		const tui = args[0];
		this.timer = setInterval(() => {
			if (!this.getActive()) return;
			this.glow = this.nextGlow();
			tui.requestRender();
		}, FRAME_MS);
	}

	private nextGlow(): number {
		const db = this.getDb();
		if (!Number.isFinite(db) || db <= -85) {
			return this.glow + (0 - this.glow) * 0.25; // no signal → ease to dark
		}
		// Ceiling tracks peaks fast / falls slow; floor tracks troughs fast / rises slow.
		this.ceilDb = db > this.ceilDb ? db : this.ceilDb + (db - this.ceilDb) * 0.02;
		this.floorDb = db < this.floorDb ? db : this.floorDb + (db - this.floorDb) * 0.05;
		const span = Math.max(7, this.ceilDb - this.floorDb); // floor on span avoids twitchiness
		const level = clamp((db - this.floorDb) / span, 0, 1);
		// Fast attack on a transient, gentle release — the frame breathes with the music.
		return this.glow + (level - this.glow) * (level > this.glow ? 0.6 : 0.3);
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (!this.getActive() || !this.truecolor || lines.length === 0) return lines;

		const top = lines[0];
		if (top !== undefined && isBorderRule(top)) lines[0] = this.glowBorder(top, width);

		for (let i = lines.length - 1; i >= 1; i--) {
			const line = lines[i];
			if (line !== undefined && isBorderRule(line)) {
				lines[i] = this.glowBorder(line, width);
				break;
			}
		}
		return lines;
	}

	private glowBorder(line: string, width: number): string {
		const chars = [...stripSgr(line)];
		const n = chars.length;
		let out = "";
		for (let i = 0; i < n; i++) {
			const ch = chars[i] ?? " ";
			if (ch === " ") {
				out += " ";
				continue;
			}
			const x = n <= 1 ? 0.5 : i / (n - 1);
			const pool = 0.6 + 0.4 * Math.cos(Math.abs(x - 0.5) * Math.PI); // brighter toward the centre
			out += glowFg(this.glow * pool) + ch;
		}
		out += "\x1b[39m";
		return truncateToWidth(out, width, "");
	}
}

export default function (pi: ExtensionAPI) {
	let active = false;
	let sampler: SystemAudioSampler | undefined;
	let editor: GlowEditor | undefined;

	const getDb = (): number => (active ? (sampler?.db() ?? -120) : -120);
	const getActive = (): boolean => active;

	const disposeEditor = (): void => {
		editor?.dispose();
		editor = undefined;
	};

	const syncSampler = (): void => {
		if (active && !sampler) {
			sampler = new SystemAudioSampler();
			sampler.start();
		} else if (!active && sampler) {
			sampler.stop();
			sampler = undefined;
		}
	};

	const applyEditor = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		disposeEditor();
		if (!active) {
			ctx.ui.setEditorComponent(undefined);
			return;
		}
		const truecolor = ctx.ui.theme.getColorMode() === "truecolor";
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			disposeEditor();
			editor = new GlowEditor(getDb, getActive, truecolor, tui, theme, keybindings);
			return editor;
		});
	};

	const apply = (ctx: ExtensionContext): void => {
		syncSampler();
		applyEditor(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				const data = entry.data as { active?: boolean } | undefined;
				if (data?.active) active = true;
			}
		}
		apply(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (active) pi.appendEntry(STATE_TYPE, { active: true });
		sampler?.stop();
		sampler = undefined;
		disposeEditor();
		if (ctx.hasUI) ctx.ui.setEditorComponent(undefined);
	});

	pi.registerCommand("aura", {
		description: "Toggle the audio-reactive glow on the input border",
		getArgumentCompletions: (prefix: string) => {
			const items = ["on", "off", "status"].map((c) => ({ value: c, label: c }));
			const filtered = items.filter((i) => i.value.startsWith(prefix.toLowerCase()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();

			if (sub === "status") {
				const audio = sampler ? ` — ${sampler.status()}` : "";
				ctx.ui.notify(`Aura ${active ? "on" : "off"}${audio}.`, "info");
				return;
			}

			if (sub === "on") active = true;
			else if (sub === "off") active = false;
			else active = !active;

			apply(ctx);

			if (active && ctx.ui.theme.getColorMode() !== "truecolor") {
				ctx.ui.notify("Aura needs a truecolor terminal; the border won't glow here.", "warning");
				return;
			}
			const audio = sampler ? ` (${sampler.status()})` : "";
			ctx.ui.notify(`Aura ${active ? "on" : "off"}${audio}.`, "info");
		},
	});
}
