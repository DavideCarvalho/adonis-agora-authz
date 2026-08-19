import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards on what the PUBLISHED manifests say — the fields no in-repo test exercises, because pnpm
 * resolves them from the workspace instead of from the registry.
 *
 * Both rules below describe failures that are invisible inside this monorepo and only appear to a
 * consumer installing the tarball. That asymmetry is the whole reason they are asserted here.
 */

// `new URL` rather than `import.meta.dirname`, which only exists from Node 20.11 — these packages
// declare `engines.node: ">=20.6.0"`, and a test asserting that field must not itself need more.
const PACKAGES_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** A range is anything carrying a comparator/wildcard — `>=`, `^`, `~`, `||`, `-`, `x`, `*`. */
const RANGE = /(>=|<=|>|<|\^|~|\|\||\s-\s|x|\*)/;

function publishableManifests(): { name: string; manifest: Record<string, unknown> }[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PACKAGES_DIR, entry.name, 'package.json'))
    .map((path) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    .filter((manifest) => manifest.private !== true)
    .map((manifest) => ({ name: String(manifest.name), manifest }));
}

/**
 * A `^` or `~` range over a 0.x peer is a latent install failure, not a style nit.
 *
 * Under semver, caret does not cross a minor below 1.0 — `^0.1.0` means `>=0.1.0 <0.2.0`. Every
 * minor release of that peer therefore falls out of range. pnpm satisfies the peer from the
 * workspace devDependency and downgrades a miss to a warning, so the monorepo never notices;
 * **npm treats it as `ERESOLVE` and refuses to install**, even when the peer is marked optional.
 * This is not hypothetical — `@adonis-agora/authz@0.10.2` shipped `"@adonis-agora/diagnostics":
 * "^0.1.0"` while diagnostics was already at 0.2.6, so the peer was unsatisfiable by every
 * published version of it:
 *
 * ```
 * Could not resolve dependency:
 * peerOptional @adonis-agora/diagnostics@"^0.1.0" from @adonis-agora/authz@0.10.2
 * Conflicting peer dependency: @adonis-agora/diagnostics@0.1.0
 * ```
 *
 * The rule is not "no pinning" — it is "say what you mean". An explicit `>=0.1.0 <0.2.0` is
 * accepted here; a caret that silently means the same thing is not, because it was almost never
 * intended and rots on the peer's next release.
 *
 * The `(^|\|\|\s*)` prefix makes the check see through a compound range, so a caret hidden in the
 * second branch of `">=1.0.0 || ^0.2.0"` is caught too.
 */
const ZERO_X_CARET_OR_TILDE = /(^|\|\|\s*)[\^~]\s*0\./;

describe('peer ranges', () => {
  const peers = publishableManifests().flatMap(({ name, manifest }) =>
    Object.entries((manifest.peerDependencies as Record<string, string>) ?? {}).map(
      ([peer, range]) => ({ pkg: name, peer, range }),
    ),
  );

  it('has peers to check', () => {
    expect(peers.length).toBeGreaterThan(0);
  });

  it.each(peers)('$pkg: $peer $range does not caret/tilde a 0.x peer', ({ peer, range }) => {
    expect(
      ZERO_X_CARET_OR_TILDE.test(range),
      `"${peer}": "${range}" pins a 0.x peer with ^ or ~, which excludes every later minor and makes npm fail with ERESOLVE. Write the range you actually mean, e.g. ">=0.1.0 <1.0.0".`,
    ).toBe(false);
  });

  it.each(publishableManifests())(
    '$name keeps every @adonis-agora/* peer open to the next minor',
    ({ manifest }) => {
      const agoraPeers = Object.entries(
        (manifest.peerDependencies as Record<string, string>) ?? {},
      ).filter(([peer]) => peer.startsWith('@adonis-agora/'));

      for (const [peer, range] of agoraPeers) {
        expect(
          ZERO_X_CARET_OR_TILDE.test(range),
          `"${peer}": "${range}" — sibling Agora packages all release 0.x minors, so a caret/tilde here breaks on their very next release.`,
        ).toBe(false);
      }
    },
  );
});

/**
 * `engines.node` must stay a RANGE, never an exact version.
 *
 * The repo's `renovate.json` sets `rangeStrategy: "pin"` globally, and Renovate happily applies that
 * to `engines` too — it once rewrote `">=20.6.0"` into `"v26.7.0"`. A published package that pins an
 * exact Node makes every consumer on any other version emit an engine warning on install (and fail
 * outright under `engine-strict`), for a constraint the package never actually had. A
 * `matchDepTypes: ["engines"], enabled: false` rule in `renovate.json` prevents it; this test is the
 * backstop that notices if that rule is ever dropped.
 */
describe('published package manifests', () => {
  const manifests = publishableManifests();

  it('finds every workspace package', () => {
    expect(manifests.map((entry) => entry.name).sort()).toEqual([
      '@adonis-agora/authz',
      '@adonis-agora/authz-react',
    ]);
  });

  it.each(manifests)(
    '$name declares engines.node as a range, not an exact version',
    ({ manifest }) => {
      const node = (manifest.engines as { node?: string } | undefined)?.node;
      expect(node, 'engines.node must be declared').toBeTypeOf('string');
      expect(
        RANGE.test(node as string),
        `engines.node is "${node}" — an exact version. Use a range such as ">=20.6.0"; Renovate's global rangeStrategy:pin must not reach engines.`,
      ).toBe(true);
    },
  );
});
