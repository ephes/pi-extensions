/** Clip to a UTF-16 code unit ceiling without splitting a surrogate pair. */
export function clipText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
}
