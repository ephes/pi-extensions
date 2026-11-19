import { visit } from "jsonc-parser";

/** Strict JSON admission via the parser's public visitor, before native decoding.
 * Key comparisons use decoded names, so escaped aliases cannot override members.
 * The member limit counts properties across all objects in the document.
 */
export function parseUnambiguousJson(
  text: string, maxDepth = 128, maxContainers = 65536, maxObjectMembers = 65536,
): unknown {
  const stack: Array<Set<string> | null> = [];
  let containers = 0;
  let objectMembers = 0;
  const invalid = () => { throw new Error("Invalid JSON structure."); };
  const begin = (keys: Set<string> | null) => {
    if (++containers > maxContainers || stack.length >= maxDepth) invalid();
    stack.push(keys);
  };
  visit(text, {
    onObjectBegin: () => begin(new Set()),
    onArrayBegin: () => begin(null),
    onObjectProperty: key => {
      const keys = stack.at(-1)!;
      if (++objectMembers > maxObjectMembers || !keys || keys.has(key)) invalid();
      keys.add(key);
    },
    onObjectEnd: () => { stack.pop(); },
    onArrayEnd: () => { stack.pop(); },
    onLiteralValue: value => {
      if (typeof value === "number" && !Number.isFinite(value)) invalid();
    },
    onError: invalid,
  }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  return JSON.parse(text);
}
