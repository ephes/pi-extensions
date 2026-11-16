import { replaceControlCharacters, stripTerminalSequences } from "@earendil-works/pi-tui";

/** Project untrusted terminal text before styling; preserve visible Unicode, tabs and line breaks. */
export function displayText(text: string): string {
  return stripTerminalSequences(text)
    .split("\n")
    .map((line) => line.split("\t").map(replaceControlCharacters).join("\t"))
    .join("\n");
}
