import dns from "node:dns/promises";
import { decodeHTML, escapeText } from "entities";
import net from "node:net";
import type { LookupFunction } from "node:net";
import { MIMEType } from "node:util";
import { defaultTreeAdapter, parse, parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import undici, { Agent, type Response } from "undici";
import { EmptyResponseReadLimitError, MAX_CONSECUTIVE_EMPTY_READS, USER_AGENT } from "./http.js";
import { clipText } from "./text.js";

export interface ReadablePage {
  url: string;
  title?: string;
  content: string;
  truncated: boolean;
  sourceTruncated: boolean;
  outputTruncated: boolean;
}

const MAX_FETCH_BYTES = 1024 * 1024 * 2;
const MAX_REDIRECTS = 5;
const FETCH_DEADLINE_MS = 30_000;
const DISPATCHER_CLEANUP_MS = 100;

const noiseTags = new Set(["script", "style", "noscript", "svg", "iframe", "nav", "header", "footer", "aside", "template"]);
const blockTags = new Set([
  "p", "div", "section", "article", "main", "h1", "h2", "h3", "h4", "h5", "h6",
  "li", "ul", "ol", "blockquote", "pre", "tr", "table", "hr", "br",
  "address", "caption", "dd", "details", "dialog", "dl", "dt", "fieldset",
  "figcaption", "figure", "form", "legend", "menu", "search", "summary",
  "center", "dir", "hgroup", "listing", "optgroup", "option", "plaintext", "xmp",
]);
// Inline boxes whose content is not part of the surrounding words.
const spaceSeparatedTags = new Set([
  "title", "td", "th", "button", "input", "select", "textarea", "img", "audio", "video", "canvas", "embed", "object",
]);

// Human-visible URLs never include access credentials or signed parameters.
export function displayUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) return "[invalid URL]";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid URL]";
  }
}

/** Readable output uses UTF-16 code units: floor, clamp to 1,000–40,000; non-finite uses 12,000. */
export function normalizeReadableLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 12000;
  return Math.max(1000, Math.min(Math.floor(limit), 40000));
}

export async function fetchReadablePage(rawUrl: string, maxChars?: number, signal?: AbortSignal): Promise<ReadablePage> {
  signal?.throwIfAborted();
  const deadline = new AbortController();
  const timeoutError = new Error("Web fetch timed out after 30 seconds; retry the request.");
  const deadlineAt = performance.now() + FETCH_DEADLINE_MS;
  const timer = setTimeout(() => deadline.abort(timeoutError), FETCH_DEADLINE_MS);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    const page = await fetchPage(rawUrl, normalizeReadableLimit(maxChars), combined);
    combined.throwIfAborted();
    // Synchronous extraction can delay the abort timer.
    if (performance.now() >= deadlineAt) throw timeoutError;
    return page;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPage(rawUrl: string, maxChars: number, signal: AbortSignal): Promise<ReadablePage> {
  signal.throwIfAborted();
  let currentUrl: URL;
  try { currentUrl = new URL(rawUrl.trim()); }
  catch { throw new Error("Invalid web URL."); }
  let redirectCount = 0;

  while (true) {
    const dispatcher = await createPinnedAgent(currentUrl, signal);
    try {
      const response = await fetchWithAbort(undici.fetch(currentUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain",
        },
        signal,
        redirect: "manual",
        dispatcher,
      }), signal).catch(() => {
        signal.throwIfAborted();
        // Transport errors (including their causes) can echo signed URLs.
        throw new Error(`Failed to fetch ${displayUrl(currentUrl.toString())}; check the URL or retry.`);
      });

      if (isRedirectStatus(response.status)) {
        void response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`Redirect response from ${displayUrl(currentUrl.toString())} did not include a Location header.`);
        }
        if (redirectCount >= MAX_REDIRECTS) {
          throw new Error(`Too many redirects while fetching ${displayUrl(rawUrl.trim())}`);
        }
        try { currentUrl = new URL(location, currentUrl); }
        catch { throw new Error("Invalid web redirect URL."); }
        redirectCount += 1;
        continue;
      }

      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`Failed to fetch ${displayUrl(currentUrl.toString())} (HTTP ${response.status})`);
      }

      if (response.status !== 200 || response.headers.has("content-range")) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Expected a complete HTTP 200 response without Content-Range.");
      }

      // Preserve legacy HTML extraction when the server omits Content-Type.
      const contentType = response.headers.get("content-type");
      const mediaType = contentType === null ? "text/html" : contentType.split(";", 1)[0].trim().toLowerCase();
      if (!["text/html", "application/xhtml+xml", "text/plain"].includes(mediaType)) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Unsupported response Content-Type; expected text/html, application/xhtml+xml or text/plain.");
      }

      const decoder = responseTextDecoder(contentType);
      const { text, truncated: sourceTruncated } = await readResponseTextWithLimit(response, MAX_FETCH_BYTES, signal, decoder).catch((error: unknown) => {
        signal.throwIfAborted();
        if (error instanceof EmptyResponseReadLimitError) throw error;
        throw new Error(`Unable to read response from ${displayUrl(currentUrl.toString())}; retry the request.`);
      });
      const { title, content: extracted } = mediaType === "text/plain"
        ? { title: undefined, content: text }
        : extractReadableHtml(mediaType === "application/xhtml+xml" ? expandXhtmlSelfClosingTags(text) : text);

      if (!extracted.trim()) {
        throw new Error(`Could not extract readable content from ${displayUrl(currentUrl.toString())}`);
      }

      const content = clipText(extracted, maxChars);
      const outputTruncated = content.length < extracted.length;

      return {
        url: currentUrl.toString(),
        title,
        content,
        truncated: sourceTruncated || outputTruncated,
        sourceTruncated,
        outputTruncated,
      };
    } finally {
      await destroyDispatcher(dispatcher, signal);
    }
  }
}

async function destroyDispatcher(dispatcher: Agent, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, DISPATCHER_CLEANUP_MS); });
    // The race observes late rejections too. Cancellation stops waiting at once;
    // destroy still owns socket teardown through Undici's public lifecycle API.
    await withAbort(Promise.race([dispatcher.destroy(), deadline]), signal);
  } catch {
    // Cleanup cannot replace the primary result/error or expose transport URLs.
  } finally {
    if (timer) clearTimeout(timer);
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

  // WHATWG URL canonicalizes equivalent IPv6 forms; zone IDs are not part
  // of the address and are unsupported by URL, so remove them after validation.
  const normalized = unbracket(new URL(`http://[${ip.split("%", 1)[0]}]/`).hostname);
  if (normalized === "::" || normalized === "::1") {
    return true;
  }

  // Local-use NAT64 permits several embedding layouts; refuse the entire /48.
  if (normalized.startsWith("64:ff9b:1:")) return true;

  const mappedIpv4 = extractEmbeddedIpv4(normalized);
  if (mappedIpv4) {
    return isBlockedIp(mappedIpv4);
  }

  const firstHextetText = normalized.split(":", 1)[0] || "0";
  const firstHextet = Number.parseInt(firstHextetText, 16);
  if (!Number.isNaN(firstHextet)) {
    if ((firstHextet & 0xfe00) === 0xfc00) return true;
    if ((firstHextet & 0xffc0) === 0xfe80) return true;
    if ((firstHextet & 0xffc0) === 0xfec0) return true;
    if ((firstHextet & 0xff00) === 0xff00) return true;
  }

  return false;
}

type HtmlParent = DefaultTreeAdapterTypes.ParentNode;

const voidTags = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);
// Ends of the regions the HTML parser reads as one comment or declaration token.
function skipXhtmlLiteral(xhtml: string, start: number): number | undefined {
  if (xhtml.startsWith("<!--", start)) {
    // One forward scan for "-->" or "--!>". Starting at "<!" also ends "<!-->" and "<!--->".
    for (let dash = xhtml.indexOf("--", start + 2); dash !== -1; dash = xhtml.indexOf("--", dash + 1)) {
      if (xhtml[dash + 2] === ">") return dash + 3;
      if (dash >= start + 4 && xhtml.startsWith("!>", dash + 2)) return dash + 4;
    }
    return xhtml.length;
  }
  // Declarations, processing instructions and HTML-content CDATA end at the first '>', even inside quotes.
  if (xhtml.startsWith("<!", start) || xhtml.startsWith("<?", start)) {
    const end = xhtml.indexOf(">", start + 2);
    return end === -1 ? xhtml.length : end + 1;
  }
  return undefined;
}

// The HTML tokenizer reads these elements' content as text up to the matching end tag.
const rawTextEndTags = new Map(
  ["iframe", "noembed", "noframes", "noscript", "script", "style", "textarea", "title", "xmp"]
    .map(name => [name, new RegExp(`</${name}[\\t\\n\\f\\r />]`, "gi")]),
);

// Follows the HTML tokenizer's attribute states: a quote delimits a value only right after the
// "=" that follows an attribute name. Elsewhere quotes and "=" are ordinary characters.
function scanXhtmlTagEnd(xhtml: string, start: number): { end: number; selfClosing: boolean } {
  let state: "beforeName" | "name" | "afterName" | "beforeValue" | "unquotedValue" = "beforeName";
  for (let cursor = start; cursor < xhtml.length; cursor++) {
    const char = xhtml[cursor];
    // Stop at an unquoted '<' so a new tag can still be found in malformed input.
    if (char === ">" || char === "<") return { end: cursor, selfClosing: false };
    // A slash in an unquoted value, including its first character, is data.
    if (char === "/" && state !== "beforeValue" && state !== "unquotedValue" && xhtml[cursor + 1] === ">") {
      return { end: cursor + 1, selfClosing: true };
    }
    const space = "\t\n\f\r ".includes(char);
    if (state === "beforeValue") {
      if (space) continue;
      if (char === '"' || char === "'") {
        const close = xhtml.indexOf(char, cursor + 1);
        if (close === -1) return { end: xhtml.length, selfClosing: false };
        cursor = close;
        state = "beforeName";
      } else {
        state = "unquotedValue";
      }
    } else if (state === "unquotedValue") {
      if (space) state = "beforeName";
    } else if (state === "beforeName") {
      if (!space && char !== "/") state = "name";
    } else if (char === "=") {
      state = "beforeValue";
    } else if (space) {
      state = "afterName";
    } else if (char === "/") {
      state = "beforeName";
    } else {
      state = "name";
    }
  }
  return { end: xhtml.length, selfClosing: false };
}

// Start tags that the HTML parser reprocesses in HTML context after leaving foreign content.
const foreignBreakoutTags = new Set([
  "b", "big", "blockquote", "body", "br", "center", "code", "dd", "div", "dl", "dt", "em",
  "embed", "h1", "h2", "h3", "h4", "h5", "h6", "head", "hr", "i", "img", "li", "listing",
  "menu", "meta", "nobr", "ol", "p", "pre", "ruby", "s", "small", "span", "strong", "strike",
  "sub", "sup", "table", "tt", "u", "ul", "var",
]);
const svgHtmlIntegrationPoints = new Set(["desc", "foreignobject", "title"]);
const mathTextIntegrationPoints = new Set(["mi", "mn", "mo", "ms", "mtext"]);

type XhtmlNamespace = "html" | "svg" | "math";
type XhtmlOpenElement = {
  name: string;
  namespace: XhtmlNamespace;
  integration: "html" | "mathText" | undefined;
  previousSameName: number | undefined;
};

function readXhtmlTagAttributes(xhtml: string, nameEnd: number, tagEnd: number) {
  // Use a neutral element so parse5 applies its attribute and character-reference rules.
  const element = parseFragment(`<x${xhtml.slice(nameEnd, tagEnd + 1)}`).childNodes[0];
  return element && defaultTreeAdapter.isElementNode(element) ? element.attrs : [];
}

function xhtmlIntegrationPoint(
  namespace: XhtmlNamespace, name: string, xhtml: string, nameEnd: number, tagEnd: number,
): XhtmlOpenElement["integration"] {
  if (namespace === "svg" && svgHtmlIntegrationPoints.has(name)) return "html";
  if (namespace === "math") {
    if (mathTextIntegrationPoints.has(name)) return "mathText";
    if (name === "annotation-xml") {
      const encoding = readXhtmlTagAttributes(xhtml, nameEnd, tagEnd).find(attr => attr.name === "encoding");
      const value = encoding?.value.toLowerCase();
      if (value === "text/html" || value === "application/xhtml+xml") return "html";
    }
  }
  return undefined;
}

/**
 * XHTML closes `<script/>`, `<nav/>` and similar elements in place. Write explicit end tags
 * in HTML context, where the parser would otherwise leave them open.
 */
export function expandXhtmlSelfClosingTags(xhtml: string): string {
  // The HTML tokenizer requires an initial ASCII letter. Only HTML whitespace, '/' and '>' end the name.
  const startTag = /<(\/?)([A-Za-z][^\t\n\f\r />]*)/y;
  const parts: string[] = [];
  let copiedThrough = 0;
  let cursor = 0;
  // Track explicit nesting from the first foreign root, including any HTML inside it.
  const openElements: XhtmlOpenElement[] = [];
  const topByName = new Map<string, number>();
  const popTo = (length: number) => {
    // Index by tag name so unmatched end tags don't rescan the stack.
    while (openElements.length > length) {
      const { name, previousSameName } = openElements.pop()!;
      if (previousSameName === undefined) topByName.delete(name);
      else topByName.set(name, previousSameName);
    }
  };

  while ((cursor = xhtml.indexOf("<", cursor)) !== -1) {
    let parent = openElements.at(-1);
    const foreignNode = parent !== undefined && parent.namespace !== "html";
    const integration = parent?.integration;
    if (foreignNode && xhtml.startsWith("<![CDATA[", cursor)) {
      const contentStart = cursor + 9;
      const close = xhtml.indexOf("]]>", contentStart);
      const end = close === -1 ? xhtml.length : close + 3;
      if (integration) {
        // parse5 reads CDATA at integration points as a bogus comment. Pass its payload as text.
        const content = xhtml.slice(contentStart, close === -1 ? xhtml.length : close);
        parts.push(xhtml.slice(copiedThrough, cursor), escapeText(content));
        copiedThrough = end;
      }
      cursor = end;
      continue;
    }
    const literalEnd = skipXhtmlLiteral(xhtml, cursor);
    if (literalEnd !== undefined) {
      cursor = literalEnd;
      continue;
    }
    const start = cursor++;
    startTag.lastIndex = start;
    const tag = startTag.exec(xhtml);
    if (!tag) continue;

    const nameEnd = startTag.lastIndex;
    const { end, selfClosing } = scanXhtmlTagEnd(xhtml, nameEnd);
    cursor = end;
    if (xhtml[cursor] !== ">") continue;
    const [, endSlash, name] = tag;
    // Match the tokenizer's ASCII case folding and replacement of null characters.
    const lowerName = name.replace(/[A-Z]/g, char => char.toLowerCase()).replaceAll("\0", "\uFFFD");
    const processForeignTags = foreignNode && !integration;
    const breakout = endSlash
      ? lowerName === "br" || lowerName === "p"
      : foreignBreakoutTags.has(lowerName) || (lowerName === "font" && processForeignTags
        && readXhtmlTagAttributes(xhtml, nameEnd, cursor).some(attr => ["color", "face", "size"].includes(attr.name)));
    if (processForeignTags && breakout) {
      while (parent && parent.namespace !== "html" && !parent.integration) {
        popTo(openElements.length - 1);
        parent = openElements.at(-1);
      }
    }
    if (endSlash) {
      const index = topByName.get(lowerName);
      if (index !== undefined) popTo(index);
    } else {
      let namespace = parent?.namespace ?? "html";
      const mathTextException = lowerName === "mglyph" || lowerName === "malignmark";
      if (parent?.integration === "html" || (parent?.integration === "mathText" && !mathTextException)
        || (namespace === "math" && parent?.name === "annotation-xml" && lowerName === "svg")
        || breakout) {
        namespace = "html";
      }
      if (namespace === "html" && (lowerName === "svg" || lowerName === "math")) namespace = lowerName;

      const htmlVoid = namespace === "html" && voidTags.has(lowerName);
      if (selfClosing && namespace === "html" && !htmlVoid) {
        parts.push(xhtml.slice(copiedThrough, cursor - 1), `></${name}>`);
        copiedThrough = cursor + 1;
      } else if (!selfClosing && !htmlVoid) {
        if (namespace !== "html" || parent) {
          const previousSameName = topByName.get(lowerName);
          topByName.set(lowerName, openElements.length);
          const integration = xhtmlIntegrationPoint(namespace, lowerName, xhtml, nameEnd, cursor);
          openElements.push({ name: lowerName, namespace, integration, previousSameName });
        }
        if (namespace === "html") {
          if (lowerName === "plaintext") break;
          const rawTextEnd = rawTextEndTags.get(lowerName);
          if (rawTextEnd) {
            // Without an end tag, the rest of the document is text.
            rawTextEnd.lastIndex = cursor + 1;
            const endTag = rawTextEnd.exec(xhtml);
            if (!endTag) break;
            cursor = endTag.index;
            continue;
          }
        }
      }
    }
    cursor++;
  }
  parts.push(xhtml.slice(copiedThrough));
  return parts.join("");
}

function findHtmlChild(parent: HtmlParent | undefined, tagName: string) {
  return parent?.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => defaultTreeAdapter.isElementNode(node) && node.tagName === tagName,
  );
}

function findTitleElement(document: DefaultTreeAdapterTypes.Document) {
  const html = findHtmlChild(document, "html");
  return findHtmlChild(findHtmlChild(html, "head"), "title");
}

function readTitle(element: DefaultTreeAdapterTypes.Element | undefined): string | undefined {
  // An HTML title contains only parsed text. Entity references are already decoded.
  const text = element?.childNodes.filter(defaultTreeAdapter.isTextNode).map(node => node.value).join("");
  return text ? cleanLine(text) || undefined : undefined;
}

export function extractTitle(html: string): string | undefined {
  return readTitle(findTitleElement(parse(html)));
}

export function extractReadableText(html: string): string {
  return extractReadableHtml(html).content;
}

function extractReadableHtml(html: string): { title?: string; content: string } {
  const document = parse(html);
  const titleElement = findTitleElement(document);
  const parts: string[] = [];
  // Walk iteratively so deeply nested markup does not consume the call stack.
  const pending: Array<DefaultTreeAdapterTypes.ChildNode | string> = [...document.childNodes].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    if (typeof node === "string") {
      parts.push(node);
    } else if (defaultTreeAdapter.isTextNode(node)) {
      parts.push(node.value);
    } else if (defaultTreeAdapter.isElementNode(node)) {
      const { tagName, childNodes } = node;
      if (noiseTags.has(tagName) || (tagName === "title" && node !== titleElement)) {
        parts.push("\n");
        continue;
      }
      let separator = "";
      if (blockTags.has(tagName)) separator = "\n";
      else if (spaceSeparatedTags.has(tagName)) separator = " ";
      if (separator) {
        parts.push(separator);
        pending.push(separator);
      }
      for (let i = childNodes.length - 1; i >= 0; i--) pending.push(childNodes[i]);
    }
  }

  const content = parts.join("").replace(/\r/g, "").split("\n").map(cleanLine).filter(Boolean).join("\n\n");
  return { title: readTitle(titleElement), content };
}

export function decodeHtml(value: string): string {
  return decodeHTML(value).replace(/\u00a0/g, " ");
}

function cleanLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

// Input is canonical IPv6. Both supported /96 prefixes put IPv4 in the low 32 bits.
function extractEmbeddedIpv4(ip: string): string | undefined {
  const prefix = ["::ffff:", "64:ff9b::"].find((candidate) => ip.startsWith(candidate));
  if (!prefix) return undefined;
  const parts = ip.slice(prefix.length).split(":");
  // More than two remaining hextets is outside the NAT64 /96.
  if (parts.length > 2) return undefined;
  const high = parts.length === 2 ? Number.parseInt(parts[0], 16) : 0;
  const low = Number.parseInt(parts.at(-1) || "0", 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function responseTextDecoder(contentType: string | null): TextDecoder {
  if (contentType !== null) {
    try {
      const charset = new MIMEType(contentType).params.get("charset");
      if (charset) return new TextDecoder(charset);
    } catch {
      // Invalid media type syntax or an unsupported decoder label uses UTF-8.
    }
  }
  return new TextDecoder();
}

async function readResponseTextWithLimit(response: Response, maxBytes: number, signal: AbortSignal, decoder: TextDecoder): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    return { text: "", truncated: false };
  }

  const reader = response.body.getReader();
  let bytesRead = 0;
  let emptyReads = 0;
  let truncated = false;
  let text = "";
  let fullyRead = false;

  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) {
        fullyRead = true;
        text += decoder.decode();
        break;
      }
      if (!value || value.byteLength === 0) {
        if (++emptyReads > MAX_CONSECUTIVE_EMPTY_READS) throw new EmptyResponseReadLimitError();
        continue;
      }
      emptyReads = 0;

      const remaining = maxBytes - bytesRead;
      if (remaining <= 0) {
        truncated = true;
        break;
      }

      if (value.byteLength > remaining) {
        text += decoder.decode(value.subarray(0, remaining), { stream: true });
        bytesRead += remaining;
        truncated = true;
        break;
      }

      text += decoder.decode(value, { stream: true });
      bytesRead += value.byteLength;
    }
  } finally {
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

// Fetch owns any response delivered after cancellation; never leave its body unclaimed.
function fetchWithAbort(operation: Promise<Response>, signal: AbortSignal): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let abandoned = false;
    const abort = () => {
      abandoned = true;
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    operation.then(response => {
      signal.removeEventListener("abort", abort);
      if (abandoned || signal.aborted) {
        try { void response.body?.cancel().catch(() => {}); }
        catch { /* Cleanup cannot replace the primary abort or expose response evidence. */ }
        reject(signal.reason);
        return;
      }
      resolve(response);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
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
