import assert from "node:assert/strict";
import test from "node:test";
import { SHADER_PALETTE_RESET, shaderLevelByte, shaderPaletteSequence } from "../src/ghostty-shader.ts";

test("shader palette encodes clamped loudness in the red channel", () => {
	assert.equal(shaderLevelByte(-1), 0);
	assert.equal(shaderLevelByte(0.5), 128);
	assert.equal(shaderLevelByte(2), 255);
	assert.equal(shaderPaletteSequence(255), "\x1b]4;232;rgb:ff/08/08\x1b\\");
	assert.equal(shaderPaletteSequence(10), "\x1b]4;232;rgb:0a/08/08\x1b\\");
	assert.equal(SHADER_PALETTE_RESET, "\x1b]104;232\x1b\\");
});
