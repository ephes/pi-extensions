import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type KagiApiMeta, formatPublishedDate, KAGI_LIMIT_DEFAULT, KAGI_LIMIT_MAX, KAGI_LIMIT_MIN, normalizeKagiLimit, searchKagi } from "../shared/kagi.js";

const RESULT_TEXT_MAX_CHARS = 24_000;
const RELATED_MAX_COUNT = 10;

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
      limit: Type.Optional(Type.Number({
        description: `Maximum number of results (${KAGI_LIMIT_MIN}-${KAGI_LIMIT_MAX}, default ${KAGI_LIMIT_DEFAULT}).`,
        minimum: KAGI_LIMIT_MIN,
        maximum: KAGI_LIMIT_MAX,
      })),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const query = params.query.trim();
      if (!query) {
        throw new Error("Query cannot be empty.");
      }

      const limit = normalizeKagiLimit(params.limit);

      onUpdate?.({
        content: [{ type: "text", text: `Searching Kagi for "${query}"...` }],
        details: { query, limit },
      });

      const response = await searchKagi(query, limit, signal);
      const results = response.data.filter((item) => item.t === 0);
      const related = response.data.filter((item) => item.t === 1).flatMap((item) => item.list);
      let truncated = results.length > limit;
      const clip = (text: string, max: number) => {
        if (text.length <= max) return text;
        truncated = true;
        return text.slice(0, max - 1) + "…";
      };
      const retainedQuery = clip(query, 512);
      // Only supported, bounded metadata enters the agent context. The transport
      // helper still validates and returns the complete response to other callers.
      const meta: KagiApiMeta | undefined = response.meta ? {} : undefined;
      if (meta && response.meta) {
        for (const key of ["id", "node"] as const) {
          const value = response.meta[key];
          if (value !== undefined) meta[key] = typeof value === "string" ? clip(value, 256) : value;
        }
        for (const key of ["ms", "api_balance"] as const) {
          if (response.meta[key] !== undefined) meta[key] = response.meta[key];
        }
        if (Object.keys(response.meta).some((key) => !["id", "node", "ms", "api_balance"].includes(key))) truncated = true;
      }

      const lines: string[] = [`# Kagi search: ${retainedQuery}`, ""];
      const urls: string[] = [];
      let remaining = RESULT_TEXT_MAX_CHARS;
      for (const result of results.slice(0, limit)) {
        // Preserve complete usable URLs rather than returning broken prefixes.
        if (result.url.length > 2048) { truncated = true; continue; }
        const row = [`${urls.length + 1}. ${clip(result.title, 512)}`, `   URL: ${result.url}`];
        if (result.snippet) row.push(`   Snippet: ${clip(result.snippet, 2048)}`);
        const published = formatPublishedDate(typeof result.published === "string" ? clip(result.published, 64) : result.published);
        if (published) row.push(`   Published: ${published}`);
        const text = row.join("\n") + "\n\n";
        if (text.length > remaining) { truncated = true; break; }
        remaining -= text.length;
        lines.push(...row, "");
        urls.push(result.url);
      }

      const retainedRelated = urls.length ? related.slice(0, RELATED_MAX_COUNT).map((term) => clip(term, 128)) : [];
      if (retainedRelated.length < related.length) truncated = true;
      if (retainedRelated.length) {
        lines.push("Related searches:", ...retainedRelated.map((term) => `- ${term}`));
      }
      let text = urls.length ? lines.join("\n").trim() : results.length
        ? `No results retained for "${retainedQuery}" within the output limits.`
        : `No results found for "${retainedQuery}".`;
      if (truncated) text += "\n\n[Search output truncated.]";

      return {
        content: [{ type: "text", text }],
        details: {
          query: retainedQuery,
          resultCount: urls.length,
          relatedCount: retainedRelated.length,
          originalResultCount: results.length,
          originalRelatedCount: related.length,
          truncated,
          meta,
          urls,
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

      if (result.isError) {
        const diagnostic = result.content.find((item) => item.type === "text")?.text ?? "";
        const limit = expanded ? 640 : 160;
        const preview = diagnostic.length > limit ? `${diagnostic.slice(0, limit)}...` : diagnostic;
        return new Text(theme.fg("error", "Kagi search failed") + (preview ? "\n" + theme.fg("dim", preview) : ""), 0, 0);
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
