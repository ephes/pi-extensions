import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { fetchReadablePage } from "../shared/web.js";

export default function webContentExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_content",
    label: "Web Content",
    description: "Fetch a web page URL and extract readable page content. Use this after kagi_search when you need the article or documentation text.",
    promptSnippet: "Fetch and extract readable page content from a URL.",
    promptGuidelines: [
      "Use web_content on URLs returned by kagi_search when the user needs the actual page text.",
      "Prefer concise extraction over full raw HTML dumps.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "HTTP or HTTPS URL to fetch." }),
      maxChars: Type.Optional(Type.Number({ description: "Maximum characters to return (default 12000).", minimum: 1000, maximum: 40000 })),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const url = params.url.trim();
      if (!url) {
        throw new Error("URL cannot be empty.");
      }

      const maxChars = Math.max(1000, Math.min(params.maxChars ?? 12000, 40000));

      onUpdate?.({
        content: [{ type: "text", text: `Fetching readable content from ${url}...` }],
        details: { url, maxChars },
      });

      const page = await fetchReadablePage(url, maxChars, signal);
      const lines = [
        page.title ? `# ${page.title}` : "# Page content",
        "",
        `URL: ${page.url}`,
        "",
        page.content,
      ];

      if (page.outputTruncated) {
        lines.push("", `[Output truncated to ${maxChars} characters.]`);
      }
      if (page.sourceTruncated) {
        lines.push("", "[Source HTML exceeded the fetch budget and was truncated before extraction.]");
      }

      return {
        content: [{ type: "text", text: lines.join("\n").trim() }],
        details: {
          url: page.url,
          title: page.title,
          truncated: page.truncated,
          sourceTruncated: page.sourceTruncated,
          outputTruncated: page.outputTruncated,
          charCount: page.content.length,
        },
      };
    },

    renderCall(args, theme) {
      const url = String(args.url ?? "");
      const shortened = url.length > 72 ? `${url.slice(0, 69)}...` : url;
      return new Text(theme.fg("toolTitle", theme.bold("web_content ")) + theme.fg("accent", shortened), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg("accent", "Fetching page content..."), 0, 0);
      }

      const details = (result.details ?? {}) as { title?: string; truncated?: boolean; charCount?: number };
      let summary = details.title ?? "Page content fetched";
      if (details.charCount) {
        summary += ` (${details.charCount} chars`;
        summary += details.truncated ? ", truncated)" : ")";
      }

      if (!expanded) {
        return new Text(theme.fg("success", summary), 0, 0);
      }

      const text = result.content.find((item) => item.type === "text")?.text ?? "";
      const preview = text.length > 320 ? `${text.slice(0, 320)}...` : text;
      return new Text(theme.fg("success", summary) + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });
}
