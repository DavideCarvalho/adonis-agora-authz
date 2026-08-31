import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppFactory } from '@adonisjs/core/factories/app';
import { describe, expect, it } from 'vitest';
import { distPreconditionMode, missingDistMessage } from './support/dist_precondition.js';

/**
 * What `node ace configure @adonis-agora/authz` hands a user.
 *
 * A `.stub` is a template no tsconfig `include` reaches and no import graph touches, so the entire
 * build/typecheck/test pipeline can be green while the generator is broken. Two distinct defects have
 * shipped in this ecosystem through that hole, and both are covered here:
 *
 * 1. **A stub that does not RENDER.** Adonis compiles a stub body with Tempura, which builds it into a
 *    JavaScript template literal. A backtick or a `${` anywhere in the body therefore terminates that
 *    literal early and the whole stub throws at generation time. This package shipped exactly that in
 *    every published version: all three stubs carried backticks in their doc comments, so `configure`
 *    aborted with `Unexpected identifier 'memory'` before writing a single file.
 * 2. **A stub emptied by tooling.** An ecosystem-wide pass that stripped backticks deleted whole stub
 *    files elsewhere, publishing zero-byte configs. Nothing here caught that either.
 *
 * The render check below is the real thing — the same `app.stubs` pipeline `codemods.makeUsingStub`
 * runs — not a regex approximation, because the approximation is what let defect 1 survive.
 *
 * It renders from `dist/stubs`, NOT from the source tree. `dist/stubs` is what `copy:stubs` produces
 * and what an installed app resolves through `stubsRoot`, so it is the only copy that can actually
 * reach a user. Checking the source instead would trust a copy step that has itself failed before:
 * the defect that started all of this was precisely a source-vs-published divergence, where the
 * shipped file was empty while the tree it was copied from looked fine.
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceStubsRoot = join(packageRoot, 'stubs');
const distStubsRoot = join(packageRoot, 'dist', 'stubs');

/**
 * Every `.stub` file under `root`, as a path relative to `root`.
 *
 * `root` is threaded through the recursion rather than reusing `dir`: relativising against the
 * current level would flatten `config/authz.stub` to `authz.stub` and make two stubs in different
 * directories collide.
 */
function findStubs(root: string, dir: string = root): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findStubs(root, full));
    else if (entry.name.endsWith('.stub')) found.push(relative(root, full));
  }
  return found;
}

/** Every stub `configure` publishes. */
const PUBLISHED = [
  'config/authz.stub',
  'abilities/authz.stub',
  'database/migrations/create_authz_tables.stub',
];

// Both trees, tagged, so a failure names which copy is broken.
const allStubs = [
  ...findStubs(sourceStubsRoot).map((file) => ({ tree: 'stubs', file, root: sourceStubsRoot })),
  ...findStubs(distStubsRoot).map((file) => ({ tree: 'dist/stubs', file, root: distStubsRoot })),
];

const mode = distPreconditionMode({
  distExists: existsSync(distStubsRoot),
  ci: Boolean(process.env.CI),
});

describe('published stubs', () => {
  it('finds every stub configure publishes in the source tree', () => {
    expect(findStubs(sourceStubsRoot).sort()).toEqual([...PUBLISHED].sort());
  });

  it.each(allStubs)('$tree/$file is not empty', ({ file, root }) => {
    const bytes = statSync(join(root, file)).size;
    expect(bytes, `${file} is empty — configure would publish a blank file`).toBeGreaterThan(0);
  });

  it.each(allStubs)('$tree/$file keeps its body free of backticks and ${ }', ({ file, root }) => {
    // Scoped to the BODY: the `{{{ … }}}` header is evaluated as JavaScript, so the migration stub's
    // `app.migrationsPath(\`${…}_create_authz_tables.ts\`)` is legitimate there and only there.
    const contents = readFileSync(join(root, file), 'utf8');
    const body = contents.replace(/\{\{\{[\s\S]*?\}\}\}/, '');

    expect(
      body,
      `${file}: a backtick in the body ends Tempura's template literal — configure throws`,
    ).not.toContain('`');
    expect(
      body,
      `${file}: a \${ } in the body is evaluated as an interpolation — configure throws`,
    ).not.toContain('${');
  });

  if (mode === 'fail') {
    it('checks the published stubs', () => {
      expect.fail(missingDistMessage(distStubsRoot));
    });
  } else if (mode === 'skip') {
    it.skip('dist/stubs does not exist — run `pnpm --filter @adonis-agora/authz build` first', () => {});
  } else {
    /**
     * The copy step is a plain `cp` in the `build` script, outside the compiler's knowledge: nothing
     * fails if it silently misses a file. Asserting the published set equals the source set is what
     * turns "the build forgot to copy a stub" from a user's runtime error into a red test here.
     */
    it('publishes every source stub into dist/stubs', () => {
      expect(findStubs(distStubsRoot).sort()).toEqual(findStubs(sourceStubsRoot).sort());
    });

    /**
     * Matching NAMES is not enough, and the gap is the historical defect exactly. The de-backtick
     * pass rewrote published stubs while their sources kept looking fine: same file, same path, same
     * set — different bytes. A divergence that still renders and still type-checks passes every other
     * check here, and it means the file that was reviewed is not the file that ships.
     *
     * `copy:stubs` is a plain `cp`, so the two copies must be byte-identical. Comparing buffers
     * rather than strings keeps encoding and line-ending drift in scope too.
     */
    it.each(findStubs(sourceStubsRoot))('dist/stubs/%s is byte-identical to its source', (file) => {
      const source = readFileSync(join(sourceStubsRoot, file));
      const published = readFileSync(join(distStubsRoot, file));

      expect(
        published.equals(source),
        `dist/stubs/${file} differs from stubs/${file} — the published stub is not the one in the tree. Re-run \`pnpm build\`; if it still differs, the copy step is rewriting content.`,
      ).toBe(true);
    });

    /**
     * The check that actually proves it: build each PUBLISHED stub through the real `app.stubs`
     * pipeline, which is what `codemods.makeUsingStub` calls from `configure.ts`. A stub that cannot
     * render throws here with the same message the user would have seen.
     */
    describe('render through the real Adonis stubs pipeline', () => {
      it.each(PUBLISHED)('%s renders to a non-empty file', async (stubPath) => {
        const app = new AppFactory().create(new URL('file:///stub-render-scratch/'));
        await app.init();
        const stubs = await app.stubs.create();

        const stub = await stubs.build(stubPath, { source: distStubsRoot });
        const prepared = await stub.prepare({});

        expect(prepared.attributes.to, `${stubPath} must declare a destination`).toBeTruthy();
        expect(
          prepared.contents.length,
          `${stubPath} rendered to nothing — configure would publish a blank file`,
        ).toBeGreaterThan(0);
        expect(prepared.contents, `${stubPath} left unrendered template syntax`).not.toMatch(
          /\{\{/,
        );
      });
    });
  }
});
