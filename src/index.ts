import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	decorateAuraFrame,
	renderRoundedAuraEditor,
	resolveEditorLayerAction,
	wrapEditorRenderer,
} from "./editor-chrome.js";
import { SHADER_PALETTE_RESET, shaderLevelByte, shaderPaletteSequence } from "./ghostty-shader.js";
import { SystemAudioSampler } from "./system-audio.js";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

const STATE_TYPE = "aura-state";
const FRAME_MS = 90;
const DECORATOR_COLLECT_EVENT = "pi:editor-decoration:collect:v1";
const DECORATOR_HOST_QUERY_EVENT = "pi:editor-decoration:host-query:v1";
const DECORATOR_HOSTS_CHANGED_EVENT = "pi:editor-decoration:hosts-changed:v1";

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

interface EditorRenderDecorator {
	id: string;
	isActive?: () => boolean;
	decorate(lines: string[], width: number): string[];
}

interface EditorDecoratorCollectRequest {
	decorators: EditorRenderDecorator[];
	requestRender: () => void;
}

interface EditorDecoratorHostQuery {
	hosts: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCollectRequest(value: unknown): value is EditorDecoratorCollectRequest {
	return isRecord(value)
		&& Array.isArray(value.decorators)
		&& typeof value.requestRender === "function";
}

class AuraGlowController {
	private glow = 0;
	private floorDb = -40;
	private ceilDb = -16;
	private requestRender: (() => void) | undefined;

	constructor(
		private readonly getDb: () => number,
		private readonly canDecorate: () => boolean,
	) {}

	setRequestRender(requestRender: (() => void) | undefined): void {
		this.requestRender = requestRender;
	}

	get level(): number {
		return this.glow;
	}

	reset(): void {
		this.glow = 0;
		this.floorDb = -40;
		this.ceilDb = -16;
	}

	tick(): void {
		if (!this.canDecorate()) return;
		this.glow = this.nextGlow();
		this.requestRender?.();
	}

	decorate(lines: string[], width: number): string[] {
		if (!this.canDecorate()) return lines;
		return decorateAuraFrame(lines, width, this.glow);
	}

	private nextGlow(): number {
		const db = this.getDb();
		if (!Number.isFinite(db) || db <= -85) {
			return this.glow + (0 - this.glow) * 0.25;
		}

		this.ceilDb = db > this.ceilDb ? db : this.ceilDb + (db - this.ceilDb) * 0.02;
		this.floorDb = db < this.floorDb ? db : this.floorDb + (db - this.floorDb) * 0.05;
		const span = Math.max(7, this.ceilDb - this.floorDb);
		const level = clamp((db - this.floorDb) / span, 0, 1);
		return this.glow + (level - this.glow) * (level > this.glow ? 0.6 : 0.3);
	}
}

class AuraEditor extends CustomEditor {
	constructor(
		private readonly glow: AuraGlowController,
		...args: ConstructorParameters<typeof CustomEditor>
	) {
		super(...args);
		this.glow.setRequestRender(() => args[0].requestRender());
	}

	override render(width: number): string[] {
		if (width < 10) return this.glow.decorate(super.render(width), width);

		const contentWidth = Math.max(1, width - 6);
		const baseLines = super.render(contentWidth);
		const framedLines = renderRoundedAuraEditor(baseLines, width, (text) => this.borderColor(text));
		return this.glow.decorate(framedLines, width);
	}
}

export default function (pi: ExtensionAPI) {
	let active = false;
	let truecolor = false;
	let shader = false;
	let shaderByte: number | undefined;
	let sessionActive = false;
	let currentCtx: ExtensionContext | undefined;
	let sampler: SystemAudioSampler | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let previousEditorFactory: EditorFactory | undefined;
	let installedEditorFactory: EditorFactory | undefined;

	const getDb = (): number => (active ? (sampler?.db() ?? -120) : -120);
	const glow = new AuraGlowController(getDb, () => active && truecolor);
	const decorator: EditorRenderDecorator = {
		id: "aura",
		isActive: () => active && truecolor,
		decorate: (lines, width) => glow.decorate(lines, width),
	};

	const hasDecorationHost = (): boolean => {
		const query: EditorDecoratorHostQuery = { hosts: new Set<string>() };
		pi.events.emit(DECORATOR_HOST_QUERY_EVENT, query);
		return query.hosts.size > 0;
	};

	const restoreOwnEditor = (ctx: ExtensionContext): void => {
		if (!installedEditorFactory || ctx.mode !== "tui") return;
		const currentFactory = ctx.ui.getEditorComponent();
		if (currentFactory !== installedEditorFactory) return;

		const factoryToRestore = previousEditorFactory;
		installedEditorFactory = undefined;
		previousEditorFactory = undefined;
		ctx.ui.setEditorComponent(factoryToRestore);
	};

	const syncEditor = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		const currentEditorFactory = ctx.ui.getEditorComponent();
		const action = resolveEditorLayerAction({
			active,
			hasHost: hasDecorationHost(),
			currentFactory: currentEditorFactory,
			installedFactory: installedEditorFactory,
		});
		if (action === "restore") {
			restoreOwnEditor(ctx);
			return;
		}
		if (action === "keep") return;

		// A host can supersede Aura without restoring Aura's prior factory. Once
		// that host is gone, discard stale layer bookkeeping and wrap the editor
		// that is actually current.
		installedEditorFactory = undefined;
		previousEditorFactory = undefined;
		const baseEditorFactory = currentEditorFactory;
		const auraEditorFactory: EditorFactory = (tui, theme, keybindings) => {
			glow.setRequestRender(() => tui.requestRender());
			const baseEditor = baseEditorFactory?.(tui, theme, keybindings);
			if (!baseEditor) return new AuraEditor(glow, tui, theme, keybindings);

			return wrapEditorRenderer(baseEditor, (lines, width) => glow.decorate(lines, width));
		};

		previousEditorFactory = baseEditorFactory;
		installedEditorFactory = auraEditorFactory;
		ctx.ui.setEditorComponent(auraEditorFactory);
	};

	const writeShaderLevel = (): void => {
		if (!shader) return;
		const byte = shaderLevelByte(glow.level);
		if (byte === shaderByte) return;
		shaderByte = byte;
		process.stdout.write(shaderPaletteSequence(byte));
	};

	const resetShaderPalette = (): void => {
		if (shaderByte === undefined) return;
		shaderByte = undefined;
		process.stdout.write(SHADER_PALETTE_RESET);
	};

	const stopRuntime = (): void => {
		resetShaderPalette();
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		sampler?.stop();
		sampler = undefined;
	};

	const shouldRunRuntime = (): boolean => active && truecolor && currentCtx?.mode === "tui";

	const ensureSampler = (): void => {
		if (sampler) return;
		sampler = new SystemAudioSampler();
		sampler.start();
	};

	const ensureRenderTimer = (): void => {
		if (timer) return;
		timer = setInterval(() => {
			glow.tick();
			writeShaderLevel();
		}, FRAME_MS);
	};

	const syncRuntime = (): void => {
		if (!shouldRunRuntime()) {
			stopRuntime();
			return;
		}
		ensureSampler();
		ensureRenderTimer();
	};

	pi.events.on(DECORATOR_COLLECT_EVENT, (value) => {
		if (!isCollectRequest(value)) return;
		glow.setRequestRender(value.requestRender);
		value.decorators.push(decorator);
	});

	pi.events.on(DECORATOR_HOSTS_CHANGED_EVENT, () => {
		if (sessionActive && currentCtx) syncEditor(currentCtx);
	});

	pi.on("session_start", async (_event, ctx) => {
		active = false;
		shader = false;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== STATE_TYPE || !isRecord(entry.data)) continue;
			if (typeof entry.data.active === "boolean") active = entry.data.active;
			if (typeof entry.data.shader === "boolean") shader = entry.data.shader;
		}

		currentCtx = ctx;
		sessionActive = true;
		truecolor = ctx.ui.theme.getColorMode() === "truecolor";
		glow.reset();
		syncRuntime();
		syncEditor(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		pi.appendEntry(STATE_TYPE, { active, shader });
		sessionActive = false;
		stopRuntime();
		restoreOwnEditor(ctx);
		glow.setRequestRender(undefined);
		currentCtx = undefined;
	});

	pi.registerCommand("aura", {
		description: "Toggle the audio-reactive glow on the input frame",
		getArgumentCompletions: (prefix: string) => {
			const items = ["on", "off", "status", "shader"].map((command) => ({ value: command, label: command }));
			const filtered = items.filter((item) => item.value.startsWith(prefix.toLowerCase()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const subcommand = args.trim().toLowerCase();

			if (subcommand === "status") {
				const audio = sampler ? `: ${sampler.status()}` : "";
				ctx.ui.notify(`Aura ${active ? "on" : "off"}, shader ${shader ? "on" : "off"}${audio}.`, "info");
				return;
			}

			if (subcommand === "shader") {
				shader = !shader;
				if (!shader) resetShaderPalette();
				pi.appendEntry(STATE_TYPE, { active, shader });
				const hint = !active
					? "it glows once /aura is on"
					: process.env.TERM_PROGRAM === "ghostty"
						? "load shaders/aura.glsl as a Ghostty custom-shader"
						: "only Ghostty custom shaders read this";
				ctx.ui.notify(`Aura shader ${shader ? `on (${hint})` : "off"}.`, "info");
				return;
			}

			if (subcommand === "on") active = true;
			else if (subcommand === "off") active = false;
			else active = !active;

			currentCtx = ctx;
			truecolor = ctx.ui.theme.getColorMode() === "truecolor";
			if (active) glow.reset();
			syncRuntime();
			syncEditor(ctx);

			if (active && !truecolor) {
				ctx.ui.notify("Aura needs a truecolor terminal; the frame cannot glow here.", "warning");
				return;
			}
			const audio = sampler ? ` (${sampler.status()})` : "";
			ctx.ui.notify(`Aura ${active ? "on" : "off"}${audio}.`, "info");
		},
	});
}
