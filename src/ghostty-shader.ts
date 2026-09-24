// Ghostty shaders can't receive custom uniforms, but they can read the live
// palette (`iPalette`). Aura smuggles loudness through one slot's red channel.
// ponytail: fixed slot; 256-color apps using 232 see a red tint while on.
export const SHADER_PALETTE_SLOT = 232;

const hex = (value: number): string => value.toString(16).padStart(2, "0");

/** Loudness 0..1 → byte stored in the slot's red channel. */
export function shaderLevelByte(level: number): number {
	return Math.round(Math.max(0, Math.min(1, level)) * 255);
}

/** OSC 4: set the slot to rgb(level, 8, 8). */
export function shaderPaletteSequence(byte: number): string {
	return `\x1b]4;${SHADER_PALETTE_SLOT};rgb:${hex(byte)}/08/08\x1b\\`;
}

/** OSC 104: restore the slot to the terminal's configured color. */
export const SHADER_PALETTE_RESET = `\x1b]104;${SHADER_PALETTE_SLOT}\x1b\\`;
