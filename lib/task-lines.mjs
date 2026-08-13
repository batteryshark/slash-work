// Rapid task entry: one typed or pasted line becomes one task title.
// Pasting a list is the whole point, so the shapes a list arrives in —
// bullets, numbers, blank lines between items — are normalized away here
// rather than in the input handlers.

/** Split typed or pasted text into one task title per non-empty line. */
export function splitTaskTitles(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*+•–]|\d+[.)])\s+/, "").trim())
    .filter(Boolean)
    .map((line) => (line.length > 500 ? `${line.slice(0, 497)}…` : line));
}
