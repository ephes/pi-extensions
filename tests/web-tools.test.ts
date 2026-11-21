import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import undici from "undici";
import kagiSearch from "../extensions/kagi_search.js";
import webContent from "../extensions/web_content.js";

type Result = { isError?: boolean; content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> };
type Component = { render(width: number): string[] };
type Tool = {
  execute(id: string, params: unknown, signal: undefined, update: (result: Result) => void): Promise<Result>;
  renderCall(args: unknown, theme: unknown): Component;
  renderResult(result: Result, options: { expanded: boolean; isPartial: boolean }, theme: unknown): Component;
};
function register(extension: typeof webContent) {
  let tool!: Tool;
  extension({ registerTool(definition: Tool) { tool = definition; } } as never);
  return tool;
}
const theme = { fg: (color: string, text: string) => `[${color}]${text}[/${color}]`, bold: (text: string) => text };
const render = (component: Component) => component.render(2000).map((line) => line.trimEnd()).join("\n");

for (const [name, extension, details, success, running] of [
  ["web", webContent, { charCount: 42, title: "Article" }, "Article", "Fetching page content"],
  ["search", kagiSearch, { resultCount: 2 }, "2 results", "Searching Kagi"],
] as const) {
  test(`${name} renderer distinguishes failure, empty success, ordinary success and partial`, () => {
    const tool = register(extension);
    for (const expanded of [false, true]) {
      for (const diagnostic of ["HTTP 403: refused", "x".repeat(2000), ""]) {
        const failed = render(tool.renderResult({ isError: true, content: [{ type: "text", text: diagnostic }], details }, { expanded, isPartial: false }, theme));
        assert.match(failed, /\[error\]/);
        assert.match(failed, /failed/i);
        assert.doesNotMatch(failed, /\[success\]|Page content fetched|\d+ results/);
        assert.ok(failed.length < 800);
        if (diagnostic && diagnostic.length < 100) assert.match(failed, /HTTP 403: refused/);
      }
      const empty = render(tool.renderResult({ content: [], details: {} }, { expanded, isPartial: false }, theme));
      assert.match(empty, /\[success\]/);
      assert.match(empty, name === "search" ? /0 results/ : /Page content fetched/);
      const normal = render(tool.renderResult({ content: [{ type: "text", text: "Useful content" }], details }, { expanded, isPartial: false }, theme));
      assert.ok(normal.includes(success));
      assert.match(normal, /\[success\]/);
      if (expanded) assert.match(normal, /Useful content/);
      const partial = render(tool.renderResult({ isError: true, content: [] }, { expanded, isPartial: true }, theme));
      assert.ok(partial.includes(running));
      assert.doesNotMatch(partial, /\[success\]|\[error\]/);
    }
  });
}

for (const [label, isError, expanded, limit] of [
  ["collapsed error", true, false, 160],
  ["expanded error", true, true, 640],
  ["expanded content", false, true, 320],
] as const) {
  test(`web ${label} preview clips at a Unicode scalar boundary`, () => {
    const tool = register(webContent);
    const preview = (text: string) => render(tool.renderResult({
      isError, content: [{ type: "text", text }],
    }, { expanded, isPartial: false }, theme)).split("\n")[1];
    const prefix = "x".repeat(limit - 1);
    assert.equal(preview(`${prefix}🙂tail`), `[dim]${prefix}...[/dim]`);
    assert.equal(preview(`${prefix.slice(1)}🙂tail`), `[dim]${prefix.slice(1)}🙂...[/dim]`);
    assert.equal(preview(`${prefix}x`), `[dim]${prefix}x[/dim]`);
    assert.equal(preview(`${prefix}xy`), `[dim]${prefix}x...[/dim]`);
  });
}

test("web call preview preserves its ASCII budget including the ellipsis", () => {
  // URL serialization percent-encodes supplementary characters before display.
  const tool = register(webContent);
  const url = "https://example.test/".padEnd(72, "x");
  assert.equal(render(tool.renderCall({ url }, theme)),
    `[toolTitle]web_content [/toolTitle][accent]${url}[/accent]`);
  assert.equal(render(tool.renderCall({ url: `${url}🙂` }, theme)),
    `[toolTitle]web_content [/toolTitle][accent]${url.slice(0, 69)}...[/accent]`);
});

test("web clips readable content at a Unicode scalar boundary", async (t) => {
  const prefix = "日本語 café ".padEnd(999, "界");
  t.mock.method(undici, "fetch", async () => new undici.Response(`${prefix}🙂fin`, {
    headers: { "content-type": "text/plain" },
  }));
  const tool = register(webContent);
  for (const [maxChars, expected] of [[1000, prefix], [1001, `${prefix}🙂`]] as const) {
    const result = await tool.execute("test", { url: "http://1.1.1.1/", maxChars }, undefined, () => {});
    assert.equal(result.content[0].text, `# Page content\n\nURL: http://1.1.1.1/\n\n${expected}\n\n[Output truncated to ${expected.length} characters.]`);
    assert.equal(result.details?.charCount, expected.length);
    assert.equal(result.details?.truncated, true);
    assert.equal(result.details?.outputTruncated, true);
    assert.equal(result.details?.sourceTruncated, false);
  }
});

test("web progress and call preview omit credentials, queries and fragments even on failure", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "1.1.1.1", family: 4 }]);
  const tool = register(webContent);
  const url = "https://invented-user:invented-password@public.example/document?signed-secret=hidden#private-fragment";
  const updates: Result[] = [];
  const call = render(tool.renderCall({ url }, theme));
  await assert.rejects(tool.execute("test", { url }, undefined, (result) => updates.push(result)), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.stack! + JSON.stringify(error), /invented-|signed-secret|hidden|private-fragment/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.doesNotMatch(JSON.stringify(updates) + call, /invented-|signed-secret|hidden|private-fragment/);
  assert.match(call, /https:\/\/public.example\/document/);
  assert.equal(updates.length, 1);
  assert.match(JSON.stringify(updates), /https:\/\/public.example\/document/);
  const invalid = render(tool.renderCall({ url: "malformed invented-secret" }, theme));
  assert.doesNotMatch(invalid, /invented-secret/);
});
