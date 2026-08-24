import test from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  decorateAuraFrame,
  renderRoundedAuraEditor,
  resolveEditorLayerAction,
  wrapEditorRenderer,
} from "../src/editor-chrome.ts";

const dimBorder = (text: string): string => `\x1b[38;5;244m${text}\x1b[0m`;

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

test("standalone Aura uses Lohan's compact rounded frame", () => {
  const contentWidth = 34;
  const rendered = renderRoundedAuraEditor(
    [
      "─".repeat(contentWidth),
      `${CURSOR_MARKER}\x1b[7m \x1b[0m${" ".repeat(contentWidth - 1)}`,
      "─".repeat(contentWidth),
    ],
    40,
    dimBorder,
  );

  assert.equal(stripTerminalSequences(rendered[0] ?? ""), `╭${"─".repeat(38)}╮`);
  assert.match(stripTerminalSequences(rendered[1] ?? ""), /^╰─ .+ ─╯$/u);
  assert.ok(rendered[1]?.includes(CURSOR_MARKER));
  assert.deepEqual(rendered.map(visibleWidth), [40, 40]);
});

test("Aura decorates frame glyphs without recoloring status or input", () => {
  const status = "\x1b[35m model / ctx 12k/200k \x1b[0m";
  const top = `${dimBorder("╭─")}${status}${dimBorder(`${"─".repeat(12)}╮`)}`;
  const input = `${dimBorder("│")}  keep │ content  ${dimBorder("│")}`;
  const decorated = decorateAuraFrame([top, input], visibleWidth(top), 0.8);

  assert.equal(stripTerminalSequences(decorated[0] ?? ""), stripTerminalSequences(top));
  assert.equal(stripTerminalSequences(decorated[1] ?? ""), stripTerminalSequences(input));
  assert.ok(decorated[0]?.includes(status));
  assert.equal(occurrences(decorated[1] ?? "", "\x1b[38;2;"), 2);
});

test("Aura preserves the cursor marker and its terminal position", () => {
  const line = `${dimBorder("╰─")} draft ${CURSOR_MARKER}\x1b[7m \x1b[0m ${dimBorder("─╯")}`;
  const beforeColumn = visibleWidth(line.slice(0, line.indexOf(CURSOR_MARKER)));
  const [decorated = ""] = decorateAuraFrame([line], visibleWidth(line), 1);
  const afterColumn = visibleWidth(decorated.slice(0, decorated.indexOf(CURSOR_MARKER)));

  assert.equal(occurrences(decorated, CURSOR_MARKER), 1);
  assert.equal(afterColumn, beforeColumn);
  assert.equal(visibleWidth(decorated), visibleWidth(line));
});

test("Aura recovers when a Powerline host supersedes and later removes its editor", () => {
  const baseFactory = () => "base";
  const auraFactory = () => "aura";
  const powerlineFactory = () => "powerline";

  assert.equal(resolveEditorLayerAction({
    active: true,
    hasHost: false,
    currentFactory: baseFactory,
    installedFactory: undefined,
  }), "install");
  assert.equal(resolveEditorLayerAction({
    active: true,
    hasHost: true,
    currentFactory: powerlineFactory,
    installedFactory: auraFactory,
  }), "keep");
  assert.equal(resolveEditorLayerAction({
    active: true,
    hasHost: false,
    currentFactory: baseFactory,
    installedFactory: auraFactory,
  }), "install");
  assert.equal(resolveEditorLayerAction({
    active: true,
    hasHost: false,
    currentFactory: auraFactory,
    installedFactory: auraFactory,
  }), "keep");
});

test("Aura wraps the current editor instance without replacing its behavior", () => {
  const editor = {
    mode: "normal",
    input: "draft",
    handleInput(value: string) {
      this.input += value;
    },
    render() {
      return [this.input];
    },
  };

  const wrapped = wrapEditorRenderer(editor, (lines) => lines.map((line) => `[${line}]`));
  wrapped.handleInput("!");

  assert.equal(wrapped, editor);
  assert.equal(wrapped.mode, "normal");
  assert.equal(wrapped.input, "draft!");
  assert.deepEqual(wrapped.render(), ["[draft!]"]);
});

test("Aura still decorates Pi's native open border rules", () => {
  const rule = `─── ↑ 2 more ${"─".repeat(20)}`;
  const [decorated = ""] = decorateAuraFrame([rule], visibleWidth(rule), 0.5);

  assert.equal(stripTerminalSequences(decorated), rule);
  assert.ok(occurrences(decorated, "\x1b[38;2;") > 20);
});
