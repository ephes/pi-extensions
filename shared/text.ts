/** Clip to a UTF-16 code unit ceiling without splitting a surrogate pair. */
export function clipText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
}

/** In Unicode mode valid pairs match as one supplementary code point. */
export function hasUnpairedSurrogate(text: string): boolean {
  return /[\uD800-\uDFFF]/u.test(text);
}
