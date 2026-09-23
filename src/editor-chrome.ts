import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const GLOW_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[72, 62, 104],
	[55, 232, 255],
	[255, 113, 206],
	[255, 232, 248],
];

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

function glowFg(intensity: number): string {
	const t = clamp(intensity, 0, 1);
	const segment = t * (GLOW_STOPS.length - 1);
	const index = Math.min(GLOW_STOPS.length - 2, Math.floor(segment));
	const offset = segment - index;
	const from = GLOW_STOPS[index]!;
	const to = GLOW_STOPS[index + 1]!;
	const red = Math.round(from[0] + (to[0] - from[0]) * offset);
	const green = Math.round(from[1] + (to[1] - from[1]) * offset);
	const blue = Math.round(from[2] + (to[2] - from[2]) * offset);
	return `\x1b[38;2;${red};${green};${blue}m`;
}

function fitToWidth(line: string, width: number): string {
	const fitted = visibleWidth(line) > width
		? truncateToWidth(line, width, "", true)
		: line;
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function hasScrollIndicator(line: string, direction: "↑" | "↓"): boolean {
	return stripTerminalSequences(line).includes(` ${direction} `);
}

function findBottomBorderIndex(lines: readonly string[]): number {
	for (let index = lines.length - 1; index >= 1; index--) {
		if (/^─{3,}/u.test(stripTerminalSequences(lines[index] ?? ""))) return index;
	}
	return lines.length - 1;
}

function renderTopBorder(width: number, hasContentAbove: boolean, border: (text: string) => string): string {
	const fillWidth = width - 4;
	return `${border(hasContentAbove ? "╭↑" : "╭─")}${border(`${"─".repeat(fillWidth)}─╮`)}`;
}

function renderInputRow(
	line: string,
	contentWidth: number,
	final: boolean,
	hasContentBelow: boolean,
	border: (text: string) => string,
): string {
	const content = fitToWidth(line, contentWidth);
	if (!final) return `${border("│")}  ${content}  ${border("│")}`;

	const rightCorner = hasContentBelow ? "↓╯" : "─╯";
	return `${border("╰─")} ${content} ${border(rightCorner)}`;
}

function renderInputRows(
	baseLines: readonly string[],
	bottomBorderIndex: number,
	width: number,
	border: (text: string) => string,
): string[] {
	const inputLines = baseLines.slice(1, bottomBorderIndex);
	const rows = inputLines.length > 0 ? inputLines : [""];
	const contentWidth = width - 6;
	const hasContentBelow = hasScrollIndicator(baseLines[bottomBorderIndex] ?? "", "↓");
	return rows.map((line, index) => renderInputRow(
		line,
		contentWidth,
		index === rows.length - 1,
		hasContentBelow,
		border,
	));
}

function canRenderRoundedFrame(baseLines: readonly string[], width: number): boolean {
	return width >= 10 && baseLines.length >= 2;
}

/** Render the compact rounded input frame. */
export function renderRoundedAuraEditor(
	baseLines: string[],
	width: number,
	border: (text: string) => string,
): string[] {
	if (!canRenderRoundedFrame(baseLines, width)) return baseLines;

	const bottomBorderIndex = findBottomBorderIndex(baseLines);
	const top = renderTopBorder(width, hasScrollIndicator(baseLines[0] ?? "", "↑"), border);
	const input = renderInputRows(baseLines, bottomBorderIndex, width, border);
	const autocomplete = baseLines.slice(bottomBorderIndex + 1);
	return [top, ...input, ...autocomplete];
}

function isNativeBorderRule(chars: readonly string[]): boolean {
	const trimmed = chars.join("").trim();
	if (trimmed.length < 3) return false;
	const ruleCharacters = [...trimmed];
	const dashes = ruleCharacters.filter((character) => character === "─").length;
	return dashes >= ruleCharacters.length * 0.5;
}

type FrameKind = "top" | "bottom" | "row" | "native";
type FrameIndexSelector = (chars: readonly string[]) => Set<number>;

function frameKind(plain: string): FrameKind {
	if (/^╭[─↑].*╮$/u.test(plain)) return "top";
	if (/^╰─.*[─↓]╯$/u.test(plain)) return "bottom";
	if (/^│.*│$/u.test(plain)) return "row";
	return "native";
}

function topFrameIndexes(chars: readonly string[]): Set<number> {
	const selected = new Set<number>([0, 1, chars.length - 1]);
	for (let index = chars.length - 2; index >= 2 && chars[index] === "─"; index--) selected.add(index);
	return selected;
}

function bottomFrameIndexes(chars: readonly string[]): Set<number> {
	return new Set<number>([0, 1, chars.length - 2, chars.length - 1]);
}

function rowFrameIndexes(chars: readonly string[]): Set<number> {
	return new Set<number>([0, chars.length - 1]);
}

function nativeFrameIndexes(chars: readonly string[]): Set<number> {
	const selected = new Set<number>();
	if (!isNativeBorderRule(chars)) return selected;
	for (let index = 0; index < chars.length; index++) {
		if (chars[index] !== " ") selected.add(index);
	}
	return selected;
}

const FRAME_INDEX_SELECTORS: Record<FrameKind, FrameIndexSelector> = {
	top: topFrameIndexes,
	bottom: bottomFrameIndexes,
	row: rowFrameIndexes,
	native: nativeFrameIndexes,
};

function frameCharacterIndexes(line: string): Set<number> {
	const plain = stripTerminalSequences(line);
	const chars = [...plain];
	return FRAME_INDEX_SELECTORS[frameKind(plain)](chars);
}

type SequenceLengthReader = (text: string, index: number) => number;

function csiSequenceLength(text: string, index: number): number {
	for (let cursor = index + 2; cursor < text.length; cursor++) {
		const code = text.charCodeAt(cursor);
		if (code >= 0x40 && code <= 0x7e) return cursor - index + 1;
	}
	return text.length - index;
}

function stringTerminatorLength(text: string, index: number): number {
	if (text.charCodeAt(index) === 0x07) return 1;
	if (text.startsWith("\x1b\\", index)) return 2;
	return 0;
}

function stringSequenceLength(text: string, index: number): number {
	for (let cursor = index + 2; cursor < text.length; cursor++) {
		const terminatorLength = stringTerminatorLength(text, cursor);
		if (terminatorLength > 0) return cursor - index + terminatorLength;
	}
	return text.length - index;
}

function shortSequenceLength(text: string, index: number): number {
	return Math.min(2, text.length - index);
}

const SEQUENCE_LENGTH_READERS: Readonly<Record<string, SequenceLengthReader>> = {
	"[": csiSequenceLength,
	"]": stringSequenceLength,
	_: stringSequenceLength,
	P: stringSequenceLength,
	"^": stringSequenceLength,
};

function terminalSequenceLength(text: string, index: number): number {
	if (text.charCodeAt(index) !== 0x1b) return 0;
	const reader = SEQUENCE_LENGTH_READERS[text[index + 1] ?? ""] ?? shortSequenceLength;
	return reader(text, index);
}

interface TerminalToken {
	text: string;
	control: boolean;
}

function readTerminalToken(text: string, index: number): TerminalToken {
	const sequenceLength = terminalSequenceLength(text, index);
	if (sequenceLength > 0) {
		return { text: text.slice(index, index + sequenceLength), control: true };
	}
	const character = String.fromCodePoint(text.codePointAt(index)!);
	return { text: character, control: false };
}

function glowCharacter(character: string, column: number, lineWidth: number, intensity: number): string {
	const position = column / Math.max(1, lineWidth - 1);
	const centerBias = 0.6 + 0.4 * Math.cos(Math.abs(position - 0.5) * Math.PI);
	return `${glowFg(intensity * centerBias)}${character}\x1b[39m`;
}

function decorateVisibleCharacter(
	character: string,
	selected: boolean,
	column: number,
	lineWidth: number,
	intensity: number,
): string {
	return selected ? glowCharacter(character, column, lineWidth, intensity) : character;
}

function decorateLine(line: string, selected: ReadonlySet<number>, intensity: number): string {
	if (selected.size === 0) return line;

	const lineWidth = Math.max(1, visibleWidth(line));
	let output = "";
	let characterIndex = 0;
	let column = 0;
	let sourceIndex = 0;

	while (sourceIndex < line.length) {
		const token = readTerminalToken(line, sourceIndex);
		sourceIndex += token.text.length;
		if (token.control) {
			output += token.text;
			continue;
		}

		output += decorateVisibleCharacter(
			token.text,
			selected.has(characterIndex),
			column,
			lineWidth,
			intensity,
		);
		column += visibleWidth(token.text);
		characterIndex++;
	}

	return output;
}

/** Add Aura color only to frame glyphs. Status and editor content keep their own styling. */
export function decorateAuraFrame(lines: string[], _width: number, intensity: number): string[] {
	return lines.map((line) => decorateLine(line, frameCharacterIndexes(line), clamp(intensity, 0, 1)));
}

export type EditorLayerAction = "install" | "keep" | "restore";

const EDITOR_LAYER_ACTIONS = [
	["keep", "restore"],
	["install", "keep"],
] as const satisfies readonly (readonly EditorLayerAction[])[];

export function resolveEditorLayerAction<T>(options: {
	active: boolean;
	hasHost: boolean;
	currentFactory: T | undefined;
	installedFactory: T | undefined;
}): EditorLayerAction {
	const wantsLayer = options.active && !options.hasHost;
	const ownsCurrentFactory = options.installedFactory !== undefined
		&& options.currentFactory === options.installedFactory;
	const wantsLayerIndex = Number(wantsLayer) as 0 | 1;
	const ownsCurrentFactoryIndex = Number(ownsCurrentFactory) as 0 | 1;
	return EDITOR_LAYER_ACTIONS[wantsLayerIndex][ownsCurrentFactoryIndex];
}

/** Decorate an existing editor instance without replacing its input or state behavior. */
export function wrapEditorRenderer<T extends { render(width: number): string[] }>(
	editor: T,
	decorate: (lines: string[], width: number) => string[],
): T {
	const baseRender = editor.render.bind(editor);
	editor.render = (width: number): string[] => decorate(baseRender(width), width);
	return editor;
}
