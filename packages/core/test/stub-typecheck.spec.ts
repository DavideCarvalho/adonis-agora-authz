import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { distPreconditionMode, missingDistMessage } from './support/dist_precondition.js';

const execFileAsync = promisify(execFile);

/**
 * Compiles every PUBLISHED stub inside a scratch consumer app, against the REAL `@adonisjs/*` types.
 *
 * This closes a coverage gap invisible to every other gate here. A `.stub` is a template no tsconfig
 * `include` reaches, so nothing type-checks the code a user actually receives from `node ace
 * configure`. The package's own typecheck compiles `src/` against the library's own types, which are
 * trivially happy with themselves.
 *
 * The failure mode is not hypothetical, and it was not hypothetical HERE: this package's migration
 * stub did not compile in a consumer app. `createAuthzTables` accepted a structural `LucidDatabase`
 * whose `rawQuery` declared `bindings?: readonly unknown[]`, which is not assignable in either
 * direction to Lucid's `RawQueryBindings` (`readonly` cannot go into the mutable `StrictValues[]`,
 * and the named-map branch is not an array), so no per-connection query client satisfied it. Every
 * check in this repo stayed green because none of them ever looked at the generated file.
 *
 * Covers all three stubs `configure` publishes — the config, the Bouncer abilities and the migration
 * — each rendered by the REAL `app.stubs` pipeline and compiled under NodeNext + strict with the
 * package resolved BY NAME, so what is checked is the shipped `dist/**\/*.d.ts` a consumer installs
 * rather than `src/`.
 */

const harness = fileURLToPath(new URL('./fixtures/stub-typecheck/check.mjs', import.meta.url));

/**
 * The harness reads `dist/stubs` (the copy an installed app resolves) and reaches the package by name
 * through its `exports` map, so BOTH halves of a build are its precondition: the published
 * declarations and the published stubs.
 */
const distTypes = fileURLToPath(new URL('../dist/src/index.d.ts', import.meta.url));
const distStubs = fileURLToPath(new URL('../dist/stubs', import.meta.url));

describe('the dist precondition', () => {
  // Resolving the package by name makes a built package a precondition. Under CI a missing build is
  // a failure, not a skip — `pnpm test` is what gates the publish, and a spec that silently skips
  // there is worse than no spec at all.
  it('runs the check whenever dist/ is present, in CI or not', () => {
    expect(distPreconditionMode({ distExists: true, ci: true })).toBe('run');
    expect(distPreconditionMode({ distExists: true, ci: false })).toBe('run');
  });

  it('fails hard, never skips, when dist/ is missing under CI', () => {
    expect(distPreconditionMode({ distExists: false, ci: true })).toBe('fail');
  });

  it('skips for a developer who has not built yet', () => {
    expect(distPreconditionMode({ distExists: false, ci: false })).toBe('skip');
  });

  it('is guaranteed a build by the task graph, so CI never reaches the fail branch', () => {
    // The non-obvious half of this gate. CI runs `pnpm test` BEFORE `pnpm build`, so without
    // `test` depending on its own `build` the harness would fail on a clean checkout for want of
    // dist/, not for want of correctness.
    const turbo = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../turbo.json', import.meta.url)), 'utf8'),
    ) as { tasks: Record<string, { dependsOn?: string[] }> };

    expect(turbo.tasks.test?.dependsOn).toContain('build');
  });
});

describe('the published stubs compile in a consumer app (real @adonisjs types)', () => {
  const mode = distPreconditionMode({
    distExists: existsSync(distTypes) && existsSync(distStubs),
    ci: Boolean(process.env.CI),
  });

  if (mode === 'fail') {
    it('type-checks the rendered stubs', () => {
      expect.fail(missingDistMessage(`${distTypes} / ${distStubs}`));
    });
  } else if (mode === 'skip') {
    it.skip('dist/ does not exist — run `pnpm --filter @adonis-agora/authz build` first', () => {});
  } else {
    // A cold `tsc` over the Lucid + Adonis declaration graph is a few seconds; 90s is a ceiling that
    // will not flake under full-suite load but still fails rather than hangs.
    it('type-checks the rendered stubs against the published declarations', async () => {
      const { stdout } = await execFileAsync(process.execPath, [harness], { timeout: 85_000 });
      expect(stdout).toContain('stub typecheck: OK');
    }, 90_000);
  }
});
