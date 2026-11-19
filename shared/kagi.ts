import { parseUnambiguousJson } from "./json.js";
import { USER_AGENT } from "./http.js";

const KAGI_API_URL = "https://kagi.com/api/v0/search";

export interface KagiApiMeta {
  id?: string | null;
  node?: string | null;
  ms?: number | null;
  api_balance?: number | null;
}

export interface KagiSearchResultItem {
  t: 0;
  url: string;
  title: string;
  snippet?: string | null;
  published?: string | number | null;
}

export interface KagiRelatedSearchesItem {
  t: 1;
  list: string[];
}

export type KagiSearchItem = KagiSearchResultItem | KagiRelatedSearchesItem;

export interface KagiSearchResponse {
  meta?: KagiApiMeta;
  data: KagiSearchItem[];
}

export const KAGI_RESPONSE_MAX_BYTES = 1024 * 1024;
export const KAGI_SEARCH_TIMEOUT_MS = 30_000;
export const KAGI_LIMIT_MIN = 1;
export const KAGI_LIMIT_MAX = 20;
export const KAGI_LIMIT_DEFAULT = 10;
export const KAGI_QUERY_MAX_BYTES = 8192;

/** Admit submitted UTF-8 bytes before trimming, progress or URL construction. */
export function admitKagiQuery(query: string): void {
  if (query.length > KAGI_QUERY_MAX_BYTES || Buffer.byteLength(query, "utf8") > KAGI_QUERY_MAX_BYTES) {
    throw new Error(`Kagi query exceeds the ${KAGI_QUERY_MAX_BYTES}-byte UTF-8 limit.`);
  }
}

/** The single Kagi result-limit policy: round to an integer, then clamp to 1-20; non-finite values use the default. */
export function normalizeKagiLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return KAGI_LIMIT_DEFAULT;
  return Math.max(KAGI_LIMIT_MIN, Math.min(Math.round(limit), KAGI_LIMIT_MAX));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNavigableResultUrl(value: string): boolean {
  // Require an absolute authority form, independent of a navigation base URL.
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validateResponse(value: unknown): KagiSearchResponse {
  const invalid = () => new Error("Kagi API response has invalid search data.");
  if (!isRecord(value) || !Array.isArray(value.data)) throw invalid();
  for (const item of value.data) {
    if (!isRecord(item)) throw invalid();
    if (item.t === 0) {
      if (typeof item.url !== "string" || !isNavigableResultUrl(item.url) || typeof item.title !== "string" ||
          (item.snippet != null && typeof item.snippet !== "string") ||
          (item.published != null && typeof item.published !== "string" &&
            !(typeof item.published === "number" && Number.isFinite(item.published)))) throw invalid();
    } else if (item.t === 1) {
      if (!Array.isArray(item.list) || !item.list.every((term: unknown) => typeof term === "string")) throw invalid();
    } else throw invalid();
  }
  if (value.meta !== undefined) {
    if (!isRecord(value.meta)) throw invalid();
    for (const key of ["id", "node"]) {
      if (value.meta[key] != null && typeof value.meta[key] !== "string") throw invalid();
    }
    for (const key of ["ms", "api_balance"]) {
      if (value.meta[key] != null &&
          !(typeof value.meta[key] === "number" && Number.isFinite(value.meta[key]))) throw invalid();
    }
  }
  // Retain optional metadata and extra fields after validating the supported projection.
  return value as unknown as KagiSearchResponse;
}

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = response.body.getReader(); }
  catch { throw new Error("Kagi API could not read response; please retry."); }
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read().catch(() => {
        throw new Error("Kagi API could not read response; please retry.");
      });
      if (done) break;
      size += value.byteLength;
      if (size > KAGI_RESPONSE_MAX_BYTES) {
        throw new Error("Kagi API response exceeds the 1 MiB byte limit.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("Kagi API response contains invalid UTF-8."); }
  } finally {
    signal.removeEventListener("abort", cancel);
    // Cancellation must not delay the deadline or the byte-limit error.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function getKagiApiKey(): string {
  const apiKey = process.env.KAGI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("KAGI_API_KEY is not set. Export your Kagi API key before using kagi_search.");
  }
  return apiKey;
}

export async function searchKagi(query: string, limit?: number, signal?: AbortSignal): Promise<KagiSearchResponse> {
  admitKagiQuery(query);
  const apiKey = getKagiApiKey();
  const normalizedLimit = normalizeKagiLimit(limit);
  const url = new URL(KAGI_API_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(normalizedLimit));

  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), KAGI_SEARCH_TIMEOUT_MS);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const timedOut = controller.signal.aborted && !signal?.aborted;
      const error = new Error(timedOut
        ? "Kagi search timed out after 30 seconds. Please retry."
        : "Kagi search cancelled.");
      error.name = timedOut ? "TimeoutError" : "AbortError";
      reject(error);
    };
    if (combined.aborted) onAbort();
    else combined.addEventListener("abort", onAbort, { once: true });
  });
  const request = async () => {
    combined.throwIfAborted();
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bot ${apiKey}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: combined,
    }).catch(() => {
      throw new Error("Kagi API transport failed; please retry.");
    });
    // A non-cooperative transport may deliver headers after cancellation.
    if (combined.aborted) {
      void response.body?.cancel().catch(() => {});
      combined.throwIfAborted();
    }
    if (!response.ok) {
      // Error bodies are never used as evidence; release them without reading.
      try { void response.body?.cancel().catch(() => {}); } catch { /* locked or disturbed body */ }
      throw new Error(`Kagi API request failed with HTTP ${response.status}; check Kagi service status or API access and retry.`);
    }
    const body = await readBody(response, combined);
    let payload: unknown;
    try { payload = parseUnambiguousJson(body, 64, 16384, 16384); }
    catch { throw new Error("Kagi API response is not valid JSON."); }
    return validateResponse(payload);
  };
  try {
    return await Promise.race([aborted, request()]);
  } finally {
    clearTimeout(timer);
    if (onAbort) combined.removeEventListener("abort", onAbort);
  }
}

export function formatPublishedDate(value: string | number | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    // Require a calendar date or an explicit-zone ISO timestamp. Date.parse
    // alone accepts ambiguous formats and silently normalizes impossible days.
    if (value.length < 10 || value.length > 29) return undefined;
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2})))?$/.exec(value);
    if (!match || match[0] !== value) return undefined;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
        Number(match[4] ?? 0) > 23 || Number(match[5] ?? 0) > 59 || Number(match[6] ?? 0) > 59 ||
        Number(match[7] ?? 0) > 23 || Number(match[8] ?? 0) > 59) return undefined;
  }
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999) return undefined;
  return date.toISOString().slice(0, 10);
}
