const KAGI_API_URL = "https://kagi.com/api/v0/search";
const USER_AGENT = "pi-extensions/0.1 (+https://github.com/jochen/pi-extensions)";

export interface KagiApiMeta {
  id?: string;
  node?: string;
  ms?: number;
  api_balance?: number;
}

export interface KagiSearchResultItem {
  t: 0;
  url: string;
  title: string;
  snippet?: string;
  published?: string | number;
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

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bot ${apiKey}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    signal,
  });

  if (!response.ok) {
    const body = (await response.text()).trim();
    const detail = body ? `: ${body.slice(0, 500)}` : "";
    throw new Error(`Kagi API request failed with HTTP ${response.status}${detail}`);
  }

  const payload = (await response.json()) as KagiSearchResponse;
  if (!Array.isArray(payload.data)) {
    throw new Error("Kagi API response did not include a valid data array.");
  }
  return payload;
}

export function formatPublishedDate(value: string | number | undefined): string | undefined {
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
