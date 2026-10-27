/**
 * Wildcard permission matcher — client-safe port of
 * `@adonis-agora/authz`'s `permission_matcher.ts`. Segment-based on `.`,
 * spatie/Laravel-style. Kept as a standalone copy (no server import) so the
 * `<Can>`/`useCan` client bundle never pulls in `@adonis-agora/authz`.
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
 * A granted list prepared once for repeated checks (internal — not part of the
 * barrel). Same semantics as {@link permissionSatisfied}: grants without a `*`
 * segment can only match by equality, so they go in a `Set`; only wildcard
 * grants are pre-split and scanned.
 */
class CompiledGrants {
  private readonly exact: Set<string>;
  private readonly grantsAll: boolean;
  private readonly patterns: string[][] = [];

  constructor(
    granted: readonly string[],
    /** Length at compile time — a cheap guard against an array mutated in place. */
    readonly length: number,
  ) {
    this.exact = new Set(granted);
    this.grantsAll = this.exact.has('*');
    for (const g of this.exact) {
      if (!g.includes('*')) continue;
      const parts = g.split('.');
      if (parts.includes('*')) this.patterns.push(parts);
    }
  }

  satisfies(required: string): boolean {
    if (this.grantsAll || this.exact.has(required)) return true;
    if (this.patterns.length === 0) return false;
    const requiredParts = required.split('.');
    for (const parts of this.patterns) {
      if (segmentsMatch(parts, requiredParts)) return true;
    }
    return false;
  }
}

const compiledByList = new WeakMap<readonly string[], CompiledGrants>();

/**
 * {@link permissionSatisfied} for the hooks/components: the share's `permissions`
 * array is compiled once and reused by every `useCan`/`<Can>` that reads the same
 * array (one Inertia page = one array), so a list of N gates costs one compile plus
 * N hash lookups instead of N full scans with a `split` per grant.
 */
export function satisfiesShared(granted: readonly string[], required: string): boolean {
  let compiled = compiledByList.get(granted);
  if (!compiled || compiled.length !== granted.length) {
    compiled = new CompiledGrants(granted, granted.length);
    compiledByList.set(granted, compiled);
  }
  return compiled.satisfies(required);
}
