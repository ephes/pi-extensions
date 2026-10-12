import dns from "node:dns/promises";
import net from "node:net";
import type { LookupFunction } from "node:net";
import { Agent, fetch, type Response } from "undici";

export interface ReadablePage {
  url: string;
  title?: string;
  content: string;
  truncated: boolean;
  sourceTruncated: boolean;
  outputTruncated: boolean;
}

const USER_AGENT = "pi-extensions/0.1 (+https://github.com/jochen/pi-extensions)";
const MAX_FETCH_BYTES = 1024 * 1024 * 2;
const MAX_REDIRECTS = 5;
const FETCH_DEADLINE_MS = 30_000;

const reComments = /<!--[\s\S]*?-->/g;
const reNoise = /<(script|style|noscript|svg|iframe|nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi;
const reBlocks = /<\/?(p|div|section|article|main|h[1-6]|li|ul|ol|blockquote|pre|tr|table|hr|br)[^>]*>/gi;
const reTags = /<[^>]+>/g;
const reMultiNl = /\n{3,}/g;
const reTitle = /<title[^>]*>(.*?)<\/title>/is;

export async function fetchReadablePage(rawUrl: string, maxChars = 20000, signal?: AbortSignal): Promise<ReadablePage> {
  const deadline = new AbortController();
  const timeoutError = new Error("Web fetch timed out after 30 seconds; retry the request.");
  const timer = setTimeout(() => deadline.abort(timeoutError), FETCH_DEADLINE_MS);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    return await fetchPage(rawUrl, maxChars, combined);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPage(rawUrl: string, maxChars: number, signal: AbortSignal): Promise<ReadablePage> {
  signal.throwIfAborted();
  let currentUrl = new URL(rawUrl.trim());
  let redirectCount = 0;

  while (true) {
    const dispatcher = await createPinnedAgent(currentUrl, signal);
    try {
      const response = await withAbort(fetch(currentUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal,
        redirect: "manual",
        dispatcher,
      }), signal);

      if (isRedirectStatus(response.status)) {
        void response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`Redirect response from ${currentUrl.toString()} did not include a Location header.`);
        }
        if (redirectCount >= MAX_REDIRECTS) {
          throw new Error(`Too many redirects while fetching ${rawUrl.trim()}`);
        }
        currentUrl = new URL(location, currentUrl);
        redirectCount += 1;
        continue;
      }

      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`Failed to fetch ${currentUrl.toString()} (HTTP ${response.status})`);
      }

      const { text: html, truncated: sourceTruncated } = await readResponseTextWithLimit(response, MAX_FETCH_BYTES, signal);
      const title = extractTitle(html);
      const extracted = extractReadableText(html);

      if (!extracted.trim()) {
        throw new Error(`Could not extract readable content from ${currentUrl.toString()}`);
      }

      const normalizedLimit = Math.max(1, maxChars);
      const outputTruncated = extracted.length > normalizedLimit;
      const content = outputTruncated ? extracted.slice(0, normalizedLimit) : extracted;

      return {
        url: currentUrl.toString(),
        title,
        content,
        truncated: sourceTruncated || outputTruncated,
        sourceTruncated,
        outputTruncated,
      };
    } finally {
      await dispatcher.destroy();
    }
  }
}

export function validateUrl(url: URL): void {
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }

  if (!url.hostname) {
    throw new Error("URL must include a hostname.");
  }

  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())) {
    throw new Error(`Blocked local hostname: ${url.hostname}`);
  }

  if (net.isIP(unbracket(url.hostname)) && isBlockedIp(unbracket(url.hostname))) {
    throw new Error(`Blocked private or local IP address: ${url.hostname}`);
  }
}

export async function validateHostname(hostname: string): Promise<void> {
  await resolveApprovedAddresses(unbracket(hostname));
}

function unbracket(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

async function resolveApprovedAddresses(hostname: string, signal?: AbortSignal) {
  const family = net.isIP(hostname);
  const records = family ? [{ address: hostname, family }] : await withAbort(dns.lookup(hostname, { all: true }), signal);
  if (records.length === 0) {
    throw new Error(`Hostname did not resolve: ${hostname}`);
  }
  if (records.some((record) => isBlockedIp(record.address))) {
    throw new Error(`Blocked hostname ${hostname}: resolves to private or local IPs`);
  }
  return records;
}

async function createPinnedAgent(url: URL, signal?: AbortSignal): Promise<Agent> {
  validateUrl(url);
  const hostname = unbracket(url.hostname);
  const records = await resolveApprovedAddresses(hostname, signal);
  const lookup: LookupFunction = (requestedHost, options, callback) => {
    if (unbracket(requestedHost) !== hostname) {
      callback(new Error("Unexpected hostname in pinned connection"), "", 0);
      return;
    }
    const family = typeof options === "number" ? options : options.family;
    const candidates = family ? records.filter((record) => record.family === family) : records;
    if (!candidates.length) {
      callback(new Error("No approved address for requested family"), "", 0);
    } else if (typeof options === "object" && options.all) {
      callback(null, candidates);
    } else {
      callback(null, candidates[0].address, candidates[0].family);
    }
  };
  return new Agent({ connect: { lookup }, autoSelectFamily: true });
}

export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (!net.isIPv6(ip)) {
    return true;
  }

  const normalized = ip.toLowerCase();
  if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0" || normalized === "::1") {
    return true;
  }

  const mappedIpv4 = extractMappedIpv4(normalized);
  if (mappedIpv4) {
    return isBlockedIp(mappedIpv4);
  }

  const firstHextetText = normalized.split(":", 1)[0] || "0";
  const firstHextet = Number.parseInt(firstHextetText, 16);
  if (!Number.isNaN(firstHextet)) {
    if ((firstHextet & 0xfe00) === 0xfc00) return true;
    if ((firstHextet & 0xffc0) === 0xfe80) return true;
    if ((firstHextet & 0xff00) === 0xff00) return true;
  }

  return false;
}

export function extractTitle(html: string): string | undefined {
  const match = html.match(reTitle);
  if (!match?.[1]) {
    return undefined;
  }
  const title = cleanLine(decodeHtml(match[1]));
  return title || undefined;
}

export function extractReadableText(html: string): string {
  let text = html.replace(reComments, " ");
  text = text.replace(reNoise, "\n");
  text = text.replace(reBlocks, "\n");
  text = text.replace(reTags, " ");
  text = decodeHtml(text);
  text = text.replace(/\r/g, "");

  const lines = text
    .split("\n")
    .map((line) => cleanLine(line))
    .filter(Boolean);

  return lines.join("\n\n").replace(reMultiNl, "\n\n").trim();
}

export function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function cleanLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function extractMappedIpv4(ip: string): string | undefined {
  const prefixes = ["::ffff:", "0:0:0:0:0:ffff:"];
  const prefix = prefixes.find((candidatePrefix) => ip.startsWith(candidatePrefix));
  if (!prefix) {
    return undefined;
  }

  const candidate = ip.slice(prefix.length);
  if (net.isIPv4(candidate)) {
    return candidate;
  }

  const parts = candidate.split(":");
  if (parts.length !== 2) {
    return undefined;
  }

  const high = Number.parseInt(parts[0], 16);
  const low = Number.parseInt(parts[1], 16);
  if (Number.isNaN(high) || Number.isNaN(low)) {
    return undefined;
  }

  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

async function readResponseTextWithLimit(response: Response, maxBytes: number, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    return { text: "", truncated: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let truncated = false;
  let text = "";
  let fullyRead = false;

  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) {
        fullyRead = true;
        break;
      }
      if (!value) {
        continue;
      }

      const remaining = maxBytes - bytesRead;
      if (remaining <= 0) {
        truncated = true;
        break;
      }

      if (value.byteLength >= remaining) {
        text += decoder.decode(value.subarray(0, remaining), { stream: true });
        bytesRead += remaining;
        truncated = true;
        break;
      }

      text += decoder.decode(value, { stream: true });
      bytesRead += value.byteLength;
    }
  } finally {
    text += decoder.decode();
    try {
      if (!fullyRead) {
        void reader.cancel().catch(() => {});
      }
    } catch {
      // Best effort cleanup of a partially consumed stream.
    }
    reader.releaseLock();
  }

  return { text, truncated };
}

// DNS lookup has no signal API; stop waiting and observe its eventual settlement.
function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const settle = (callback: () => void) => {
      signal.removeEventListener("abort", abort);
      callback();
    };
    operation.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
