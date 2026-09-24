import type { AudioBands } from "./system-audio.js";

// Ghostty shaders can't receive custom uniforms, but they can read the live
// palette (`iPalette`). Aura smuggles its signals through a few slots:
//   232: r = overall level, g = bass,      b = treble
//   233: r = beat pulse,    g = mid,       b = token stream rate
//   234: r = thinking,      g = tool busy, b = error flash
// ponytail: fixed slots; 256-color apps using 232-234 see odd grays while on.
export const SHADER_SLOTS = [232, 233, 234] as const;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const hex = (value: number): string => value.toString(16).padStart(2, "0");

/** 0..1 → byte for a palette channel. */
export function shaderByte(value: number): number {
	return Math.round(clamp01(value) * 255);
}

/** OSC 4: set one slot to the given 0..1 rgb. */
export function shaderPaletteSequence(slot: number, rgb: readonly [number, number, number]): string {
	return `\x1b]4;${slot};rgb:${rgb.map((v) => hex(shaderByte(v))).join("/")}\x1b\\`;
}

/** OSC 104: restore the slots to the terminal's configured colors. */
export const SHADER_PALETTE_RESET = SHADER_SLOTS.map((slot) => `\x1b]104;${slot}\x1b\\`).join("");

/** Maps dB to 0..1 against a floor and ceiling that track the music, so quiet and loud tracks both fill the range. */
export class AdaptiveMeter {
	private floor = -40;
	private ceil = -16;
	private value = 0;

	next(db: number): number {
		if (!Number.isFinite(db) || db <= -85) {
			this.value *= 0.75;
			return this.value;
		}
		this.ceil = db > this.ceil ? db : this.ceil + (db - this.ceil) * 0.02;
		this.floor = db < this.floor ? db : this.floor + (db - this.floor) * 0.05;
		const level = clamp01((db - this.floor) / Math.max(7, this.ceil - this.floor));
		this.value += (level - this.value) * (level > this.value ? 0.7 : 0.35);
		return this.value;
	}
}

/** Kick detector: fires when bass jumps well above its recent average, then decays. */
export class BeatDetector {
	private average = 0;
	private pulse = 0;
	private cooldown = 0;

	next(bassDb: number): number {
		const energy = Number.isFinite(bassDb) && bassDb > -85 ? 10 ** (bassDb / 10) : 0;
		const onset = this.average > 0 && energy > this.average * 1.6 && energy > 1e-5 && this.cooldown <= 0;
		this.average = this.average === 0 ? energy : this.average + (energy - this.average) * 0.08;
		this.pulse *= 0.8;
		this.cooldown--;
		if (onset) {
			this.pulse = 1;
			this.cooldown = 5; // ~150 ms at 30 fps
		}
		return this.pulse;
	}
}

/** Agent activity, written by pi event handlers and consumed by the feed each frame. */
export class AgentSignals {
	thinking = false;
	tools = 0;
	tokens = 0;
	errored = false;

	clear(): void {
		this.thinking = false;
		this.tools = 0;
		this.tokens = 0;
		this.errored = false;
	}
}

const ease = (value: number, target: number, rate: number): number => value + (target - value) * rate;

/** Turns audio and agent activity into palette writes, emitting only what changed. */
export class ShaderFeed {
	private readonly level = new AdaptiveMeter();
	private readonly bass = new AdaptiveMeter();
	private readonly mid = new AdaptiveMeter();
	private readonly treble = new AdaptiveMeter();
	private readonly beat = new BeatDetector();
	private thinking = 0;
	private tool = 0;
	private tokenRate = 0;
	private error = 0;
	private last = new Map<number, string>();

	next(db: number, bands: AudioBands, agent: AgentSignals): string {
		this.thinking = ease(this.thinking, agent.thinking ? 1 : 0, 0.12);
		this.tool = ease(this.tool, agent.tools > 0 ? 1 : 0, 0.15);
		// ~3 deltas per 33 ms frame is a fast stream.
		this.tokenRate = ease(this.tokenRate, clamp01(agent.tokens / 3), 0.25);
		this.error = agent.errored ? 1 : this.error * 0.9;
		agent.tokens = 0;
		agent.errored = false;

		const values: [number, [number, number, number]][] = [
			[232, [this.level.next(db), this.bass.next(bands.bass), this.treble.next(bands.treble)]],
			[233, [this.beat.next(bands.bass), this.mid.next(bands.mid), this.tokenRate]],
			[234, [this.thinking, this.tool, this.error]],
		];
		let out = "";
		for (const [slot, rgb] of values) {
			const sequence = shaderPaletteSequence(slot, rgb);
			if (this.last.get(slot) === sequence) continue;
			this.last.set(slot, sequence);
			out += sequence;
		}
		return out;
	}

	reset(): void {
		this.last.clear();
	}
}
