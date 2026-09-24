import assert from "node:assert/strict";
import test from "node:test";
import { AgentSignals, BeatDetector, SHADER_PALETTE_RESET, ShaderFeed, shaderPaletteSequence } from "../src/ghostty-shader.ts";

test("shader palette encodes clamped 0..1 channels", () => {
	assert.equal(shaderPaletteSequence(232, [1, 0.5, -1]), "\x1b]4;232;rgb:ff/80/00\x1b\\");
	assert.equal(SHADER_PALETTE_RESET, "\x1b]104;232\x1b\\\x1b]104;233\x1b\\\x1b]104;234\x1b\\");
});

test("beat detector fires on a bass jump, decays, and ignores steady bass", () => {
	const beat = new BeatDetector();
	for (let i = 0; i < 40; i++) assert.ok(beat.next(-40) < 1, "steady bass never fires");
	assert.equal(beat.next(-20), 1);
	assert.ok(beat.next(-20) < 1, "pulse decays and cooldown blocks a retrigger");
	assert.equal(new BeatDetector().next(-120), 0);
});

test("shader feed only emits slots that changed", () => {
	const feed = new ShaderFeed();
	const agent = new AgentSignals();
	const silent = { bass: -120, mid: -120, treble: -120 };
	assert.match(feed.next(-120, silent, agent), /\]4;232;.*\]4;233;.*\]4;234;/);
	assert.equal(feed.next(-120, silent, agent), "");
	feed.reset();
	assert.notEqual(feed.next(-120, silent, agent), "");
});

test("a tool error flashes slot 234's blue channel once, then fades", () => {
	const feed = new ShaderFeed();
	const agent = new AgentSignals();
	const silent = { bass: -120, mid: -120, treble: -120 };
	feed.next(-120, silent, agent);
	agent.errored = true;
	assert.match(feed.next(-120, silent, agent), /\]4;234;rgb:00\/00\/ff/);
	assert.equal(agent.errored, false, "feed consumes the error");
	assert.match(feed.next(-120, silent, agent), /\]4;234;rgb:00\/00\/e6/);
});
