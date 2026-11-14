import { visit } from "jsonc-parser";

/** Strict JSON admission via the parser's public visitor, before native decoding.
 * Key comparisons use decoded names, so escaped aliases cannot override members.
 */
export function parseUnambiguousJson(text: string, maxDepth = 128, maxContainers = 65536): unknown {
  const stack: Array<Set<string> | null> = [];
  let containers = 0;
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
      if (!keys || keys.has(key)) invalid();
      keys.add(key);
    },
    onObjectEnd: () => { stack.pop(); },
    onArrayEnd: () => { stack.pop(); },
    onError: invalid,
  }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  return JSON.parse(text);
}
