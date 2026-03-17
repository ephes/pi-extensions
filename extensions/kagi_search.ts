import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { formatPublishedDate, searchKagi } from "../shared/kagi.js";

export default function kagiSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "kagi_search",
    label: "Kagi Search",
    description: "Search the web with the official Kagi Search API. Requires KAGI_API_KEY. Returns titles, URLs, snippets, and related searches.",
    promptSnippet: "Search the web with Kagi when the user asks for current information, external documentation, or web research.",
    promptGuidelines: [
      "Use kagi_search instead of ad-hoc bash-based web search when Kagi is available.",
      "When the user needs page text after searching, follow up with web_content on a chosen result URL.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      limit: Type.Optional(Type.Number({ description: "Maximum number of results (1-20, default 10).", minimum: 1, maximum: 20 })),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const query = params.query.trim();
      if (!query) {
        throw new Error("Query cannot be empty.");
      }

      const limit = Math.max(1, Math.min(params.limit ?? 10, 20));

      onUpdate?.({
        content: [{ type: "text", text: `Searching Kagi for "${query}"...` }],
        details: { query, limit },
      });

      const response = await searchKagi(query, limit, signal);
      const results = response.data.filter((item) => item.t === 0);
      const related = response.data.filter((item) => item.t === 1).flatMap((item) => item.list);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No results found for "${query}".` }],
          details: { query, resultCount: 0, relatedCount: related.length, meta: response.meta },
        };
      }

      const lines: string[] = [];
      lines.push(`# Kagi search: ${query}`);
      lines.push("");

      results.forEach((result, index) => {
        lines.push(`${index + 1}. ${result.title}`);
        lines.push(`   URL: ${result.url}`);
        if (result.snippet) {
          lines.push(`   Snippet: ${result.snippet}`);
        }
        const published = formatPublishedDate(result.published);
        if (published) {
          lines.push(`   Published: ${published}`);
        }
        lines.push("");
      });

      if (related.length > 0) {
        lines.push("Related searches:");
        for (const term of related) {
          lines.push(`- ${term}`);
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n").trim() }],
        details: {
          query,
          resultCount: results.length,
          relatedCount: related.length,
          meta: response.meta,
          urls: results.map((result) => result.url),
        },
      };
    },

    renderCall(args, theme) {
      const query = String(args.query ?? "");
      const shortened = query.length > 60 ? `${query.slice(0, 57)}...` : query;
      return new Text(theme.fg("toolTitle", theme.bold("kagi_search ")) + theme.fg("accent", shortened), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg("accent", "Searching Kagi..."), 0, 0);
      }

      const details = (result.details ?? {}) as { resultCount?: number; relatedCount?: number };
      const summary = `${details.resultCount ?? 0} results` + ((details.relatedCount ?? 0) > 0 ? `, ${details.relatedCount} related` : "");

      if (!expanded) {
        return new Text(theme.fg("success", summary), 0, 0);
      }

      const text = result.content.find((item) => item.type === "text")?.text ?? "";
      const preview = text.length > 320 ? `${text.slice(0, 320)}...` : text;
      return new Text(theme.fg("success", summary) + "\n" + theme.fg("dim", preview), 0, 0);
    },
  });
}
