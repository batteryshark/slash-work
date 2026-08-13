// Project tags: one cross-cutting attribute the folder hierarchy cannot
// express. Areas are perpetual, projects end, and a project can sit in an area
// without the path growing a third nesting level.
//
// Tags are free text. There is no registry file and no controlled vocabulary:
// a workspace's vocabulary is whatever its projects already use. Normalization
// is the only rule.

/** Trim, drop blanks, dedupe case-insensitively, keep the first-seen casing. */
export function normalizeTags(values) {
  const seen = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== "string") continue;
    const tag = value.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (!seen.has(key)) seen.set(key, tag);
  }
  return [...seen.values()];
}

/** Suggestions are derived, never stored: the union of every project's tags. */
export function workspaceTags(projects) {
  return normalizeTags((projects ?? []).flatMap((project) => project?.tags ?? []))
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
}

// Hues chosen to stay distinguishable at both the light and dark chip
// lightnesses defined in globals.css.
export const TAG_HUE_ANGLES = [8, 40, 92, 152, 190, 232, 276, 322];

/**
 * A tag's colour is a pure function of its name, so the desktop and the phone
 * agree with no stored field and nothing to sync. Colour is redundant
 * reinforcement only: a chip always shows the tag name, never colour alone.
 * Ported verbatim to Swift in ios/Work/Components.swift — keep both in step.
 */
export function tagHueIndex(tag) {
  const key = String(tag).toLowerCase();
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(index)) >>> 0;
  }
  return hash % TAG_HUE_ANGLES.length;
}

/** The CSS hue angle for a tag, used as the `--tag-h` custom property. */
export function tagHueAngle(tag) {
  return TAG_HUE_ANGLES[tagHueIndex(tag)];
}
