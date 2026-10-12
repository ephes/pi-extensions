const KAGI_API_URL = "https://kagi.com/api/v0/search";
const USER_AGENT = "pi-extensions/0.1 (+https://github.com/jochen/pi-extensions)";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateResponse(value: unknown): KagiSearchResponse {
  const invalid = () => new Error("Kagi API response has invalid search data.");
  if (!isRecord(value) || !Array.isArray(value.data)) throw invalid();
  for (const item of value.data) {
    if (!isRecord(item)) throw invalid();
    if (item.t === 0) {
      if (typeof item.url !== "string" || typeof item.title !== "string" ||
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
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
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
    return new TextDecoder().decode(bytes);
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

export async function searchKagi(query: string, limit = 10, signal?: AbortSignal): Promise<KagiSearchResponse> {
  const apiKey = getKagiApiKey();
  const normalizedLimit = Math.max(1, Math.min(limit, 100));
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
    });
    // A non-cooperative transport may deliver headers after cancellation.
    if (combined.aborted) {
      void response.body?.cancel().catch(() => {});
      combined.throwIfAborted();
    }
    const body = await readBody(response, combined);
    if (!response.ok) {
      const safeBody = body.trim().split(apiKey).join("[redacted]");
      const detail = safeBody ? `: ${safeBody.slice(0, 500)}` : "";
      throw new Error(`Kagi API request failed with HTTP ${response.status}${detail}`);
    }
    let payload: unknown;
    try { payload = JSON.parse(body); }
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
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "number") {
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toISOString().slice(0, 10);
}
