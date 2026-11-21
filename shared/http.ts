/** User-Agent sent by every outgoing request made by the shared helpers. */
export const USER_AGENT = "pi-extensions/0.1 (+https://github.com/jochen/pi-extensions)";

/** Bound ready reads that make no progress toward a response's byte limit. */
export const MAX_CONSECUTIVE_EMPTY_READS = 256;

export class EmptyResponseReadLimitError extends Error {
  constructor() {
    super("Response body exceeded the consecutive empty-read limit; retry the request.");
  }
}
