import test from "node:test";
import assert from "node:assert/strict";
import webContent from "../extensions/web_content.js";
import kagiSearch from "../extensions/kagi_search.js";
import { displayText } from "../shared/display.js";
import workflow from "../extensions/agent_workflow/index.js";

const attack = "Grüße 東京\u001b]52;c;Y2xpcA==\u0007\u001b[2J\u001b[9;9H\u001b[31mRot\u001b[0m\u009b2J\u0000";
type Component = { render(width: number): string[] };
type Tool = {
  renderCall(args: unknown, theme: unknown): Component;
  renderResult(result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: unknown): Component;
};
const theme = {
  fg: (_color: string, text: string) => {
    for (const control of ["\u001b", "\u0000", "\u0007", "\u009b"]) assert.equal(text.includes(control), false);
    return text;
  },
  bold: (text: string) => text,
};
const render = (component: Component) => component.render(2000).join("\n");
function register(extension: typeof webContent) {
  let tool!: Tool;
  extension({ registerTool(definition: Tool) { tool = definition; } } as never);
  return tool;
}
for (const [name, extension] of [["web", webContent], ["kagi", kagiSearch]] as const) {
  test(`${name} projects external display strings before styling, preserving source content`, () => {
    const tool = register(extension);
    const result = { content: [{ type: "text", text: attack }], details: { title: attack, resultCount: 1 } };
    for (const expanded of [false, true]) {
      for (const isError of [false, true]) {
        const output = render(tool.renderResult({ ...result, isError }, { expanded, isPartial: false }, theme));
        for (const control of ["\u001b]52", "\u001b[2J", "\u001b[9;9H", "\u009b"]) assert.equal(output.includes(control), false);
        if (expanded || isError || name === "web") assert.match(output, /Grüße 東京/);
      }
    }
    render(tool.renderCall({ query: attack, url: "https://example.test/" + attack }, theme));
    assert.equal(result.content[0].text, attack);
    assert.equal(result.details.title, attack);
  });
}
test("workflow projects diagnostics, labels, tasks, tool arguments and Markdown answers in every mode", () => {
  const tool = register(workflow);
  const entry = {
    agent: attack, task: attack, warnings: [attack], errorMessage: attack, stopReason: attack,
    exitCode: 1, model: attack, step: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    messages: [{ role: "assistant", content: [{ type: "text", text: attack }, { type: "toolCall", id: "x", name: "bash", arguments: { command: attack } }] }],
  };
  for (const mode of ["single", "chain", "parallel"]) {
    for (const expanded of [false, true]) {
      const result = { content: [], details: { mode, diagnostics: [attack], results: [entry] } };
      const output = render(tool.renderResult(result, { expanded, isPartial: false }, theme));
      for (const control of ["\u001b]52", "\u001b[2J", "\u001b[9;9H", "\u009b"]) assert.equal(output.includes(control), false);
      assert.match(output, /Grüße 東京/);
    }
  }
  render(tool.renderResult({ content: [{ type: "text", text: attack }] }, { expanded: false, isPartial: false }, theme));
  for (const args of [{ agent: attack, task: attack }, { chain: [{ agent: attack, task: attack }] }, { tasks: [{ agent: attack, task: attack }] }]) render(tool.renderCall(args, theme));
  assert.equal(entry.messages[0].content[0].text, attack);
});

test("display projection preserves Unicode and newlines before application styles are added", () => {
  assert.equal(displayText("Grüße 東京\n\u001b[31mRot\u001b[0m"), "Grüße 東京\nRot");
  assert.equal(displayText("```go\nfunc f() {\n\treturn\n}\n```"), "```go\nfunc f() {\n\treturn\n}\n```");
  assert.equal(displayText("-\ta\n\t-\tb\u0007\u001b[2J"), "-\ta\n\t-\tb ");
  const tool = register(webContent);
  const styledTheme = { fg: (_color: string, text: string) => `\u001b[32m${text}\u001b[0m`, bold: (text: string) => text };
  const output = render(tool.renderResult({ content: [], details: { title: attack } }, { expanded: false, isPartial: false }, styledTheme));
  assert.ok(output.includes("\u001b[32m"));
  assert.equal(output.includes("\u001b[31m"), false);
  assert.equal(output.includes("\u001b]52"), false);
});
