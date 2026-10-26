/**
 * Wildcard permission matcher — ported verbatim (semantics) from nestjs-authz
 * `permission-matcher.ts`. Segment-based on `.`, spatie/Laravel-style.
 *
 * Only the GRANTED (left) side may contain wildcards. The REQUIRED ability is
 * always treated literally — a check is never itself a pattern.
 *
 * Rules:
 * - `granted === required` → exact match.
 * - bare `granted === '*'` → matches anything.
 * - Split both on `.` and walk the granted segments:
 *   - A trailing `*` matches ONE-OR-MORE remaining required segments. So
 *     `posts.*` matches `posts.edit` and `posts.edit.draft`, but NOT the bare
 *     `posts` (zero remaining segments fails).
 *   - An interior `*` consumes exactly one required segment (fails if missing).
 *   - A literal segment must equal the required segment exactly.
 * - After consuming all granted segments with no trailing-wildcard early-return,
 *   the match holds only if both sides have the same number of segments.
 */
export function permissionMatches(granted: string, required: string): boolean {
  if (granted === required) return true;
  if (granted === '*') return true;
  return segmentsMatch(granted.split('.'), required.split('.'));
}

function segmentsMatch(grantedParts: readonly string[], requiredParts: readonly string[]): boolean {
  for (let i = 0; i < grantedParts.length; i++) {
    const g = grantedParts[i];
    if (g === '*') {
      if (i === grantedParts.length - 1) {
        // Trailing wildcard: one-or-more remaining required segments.
        return requiredParts.length > i;
      }
      // Interior wildcard: consume exactly one required segment.
      if (requiredParts[i] === undefined) return false;
      continue;
    }
    if (g !== requiredParts[i]) return false;
  }

  return grantedParts.length === requiredParts.length;
}

/** True when any granted pattern in the set matches the required ability. */
export function permissionSatisfied(granted: Iterable<string>, required: string): boolean {
  for (const g of granted) {
    if (permissionMatches(g, required)) return true;
  }
  return false;
}

/**
 * A granted set prepared once for repeated checks, with the same semantics as
 * {@link permissionSatisfied}: grants without a `*` segment can only match by
 * equality, so they live in a `Set`; only the wildcard grants are pre-split and
 * scanned. A check costs one hash lookup plus one pass over the wildcard grants.
 */
export class CompiledPermissions {
  readonly granted: ReadonlySet<string>;
  private readonly grantsAll: boolean;
  private readonly patterns: string[][] = [];

  constructor(granted: Iterable<string>) {
    const set = new Set(granted);
    this.granted = set;
    this.grantsAll = set.has('*');
    for (const g of set) {
      if (!g.includes('*')) continue;
      const parts = g.split('.');
      if (parts.includes('*')) this.patterns.push(parts);
    }
  }

  satisfies(required: string): boolean {
    if (this.grantsAll || this.granted.has(required)) return true;
    if (this.patterns.length === 0) return false;
    const requiredParts = required.split('.');
    for (const parts of this.patterns) {
      if (segmentsMatch(parts, requiredParts)) return true;
    }
    return false;
  }
}
