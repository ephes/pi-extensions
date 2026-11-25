import { displayText } from "../shared/display.js";
import { clipText } from "../shared/text.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type KagiApiMeta, admitKagiQuery, formatPublishedDate, KAGI_LIMIT_DEFAULT, KAGI_LIMIT_MAX, KAGI_LIMIT_MIN, KAGI_QUERY_MAX_BYTES, normalizeKagiLimit, searchKagi } from "../shared/kagi.js";

const RESULT_TEXT_MAX_CHARS = 24_000;
const TRUNCATION_NOTICE = "\n\n[Search output truncated.]";
const RELATED_MAX_COUNT = 10;

/** Shorten to at most `max` UTF-16 code units with an ellipsis, never leaving a lone high surrogate. */
function shorten(text: string, max: number): string {
  return text.length <= max ? text : clipText(text, max - 1) + "…";
}

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
      query: Type.String({ description: `Valid Unicode search query (at most ${KAGI_QUERY_MAX_BYTES} UTF-8 bytes before trimming).` }),
      limit: Type.Optional(Type.Number({
        description: `Maximum number of results (${KAGI_LIMIT_MIN}-${KAGI_LIMIT_MAX}, default ${KAGI_LIMIT_DEFAULT}).`,
        minimum: KAGI_LIMIT_MIN,
        maximum: KAGI_LIMIT_MAX,
      })),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const query = admitKagiQuery(params.query);

      const limit = normalizeKagiLimit(params.limit);
      const preview = shorten(query, 512);

      onUpdate?.({
        content: [{ type: "text", text: `Searching Kagi for "${preview}"...` }],
        details: { query: preview, limit },
      });

      const response = await searchKagi(query, limit, signal);
      const results = response.data.filter((item) => item.t === 0);
      let truncated = false;
      const clip = (text: string, max: number) => {
        if (text.length <= max) return text;
        truncated = true;
        return shorten(text, max);
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

      const retainedRelated: string[] = [];
      const seenRelated = new Set<string>();
      let originalRelatedCount = 0;
      for (const item of response.data) {
        if (item.t !== 1) continue;
        originalRelatedCount += item.list.length;
        for (const term of item.list) {
          if (retainedRelated.length === RELATED_MAX_COUNT) break;
          if (seenRelated.has(term)) continue;
          seenRelated.add(term);
          retainedRelated.push(clip(term, 128));
        }
      }
      const heading = `# Kagi search: ${retainedQuery}`;
      const relatedText = retainedRelated.length
        ? "\n\nRelated searches:\n" + retainedRelated.map((term) => `- ${term}`).join("\n")
        : "";
      const rows: string[] = [];
      const urls: string[] = [];
      let remaining = RESULT_TEXT_MAX_CHARS - heading.length - relatedText.length - TRUNCATION_NOTICE.length;
      for (const result of results) {
        if (urls.length === limit) { truncated = true; break; }
        // Preserve complete usable URLs rather than returning broken prefixes.
        if (result.url.length > 2048) { truncated = true; continue; }
        const row = [`${urls.length + 1}. ${clip(result.title, 512)}`, `   URL: ${result.url}`];
        if (result.snippet) row.push(`   Snippet: ${clip(result.snippet, 2048)}`);
        const published = formatPublishedDate(result.published);
        if (published) row.push(`   Published: ${published}`);
        const text = "\n\n" + row.join("\n");
        if (text.length > remaining) { truncated = true; break; }
        remaining -= text.length;
        rows.push(text);
        urls.push(result.url);
      }

      const relatedCount = urls.length ? retainedRelated.length : 0;
      if (relatedCount < originalRelatedCount) truncated = true;
      let text = urls.length ? (heading + rows.join("") + relatedText).trim() : results.length
        ? `No results retained for "${retainedQuery}" within the output limits.`
        : `No results found for "${retainedQuery}".`;
      if (truncated) text += TRUNCATION_NOTICE;

      return {
        content: [{ type: "text", text }],
        details: {
          query: retainedQuery,
          resultCount: urls.length,
          relatedCount,
          originalResultCount: results.length,
          originalRelatedCount,
          truncated,
          meta,
          urls,
        },
      };
    },

    renderCall(args, theme) {
      const query = String(args.query ?? "");
      const shortened = query.length > 60 ? `${query.slice(0, 57)}...` : query;
      return new Text(theme.fg("toolTitle", theme.bold("kagi_search ")) + theme.fg("accent", displayText(shortened)), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg("accent", "Searching Kagi..."), 0, 0);
      }

      if (result.isError) {
        const diagnostic = result.content.find((item) => item.type === "text")?.text ?? "";
        const limit = expanded ? 640 : 160;
        const preview = diagnostic.length > limit ? `${diagnostic.slice(0, limit)}...` : diagnostic;
        return new Text(theme.fg("error", "Kagi search failed") + (preview ? "\n" + theme.fg("dim", displayText(preview)) : ""), 0, 0);
      }

      const details = (result.details ?? {}) as { resultCount?: number; relatedCount?: number };
      const summary = `${details.resultCount ?? 0} results` + ((details.relatedCount ?? 0) > 0 ? `, ${details.relatedCount} related` : "");

      if (!expanded) {
        return new Text(theme.fg("success", displayText(summary)), 0, 0);
      }

      const text = result.content.find((item) => item.type === "text")?.text ?? "";
      const preview = text.length > 320 ? `${text.slice(0, 320)}...` : text;
      return new Text(theme.fg("success", displayText(summary)) + "\n" + theme.fg("dim", displayText(preview)), 0, 0);
    },
  });
}
