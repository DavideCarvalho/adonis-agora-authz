import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppFactory } from '@adonisjs/core/factories/app';
import { describe, expect, it } from 'vitest';

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
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const stubsRoot = join(packageRoot, 'stubs');

/** Every `.stub` file under `dir`, relative to the package root. */
function findStubs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findStubs(full));
    else if (entry.name.endsWith('.stub')) found.push(relative(packageRoot, full));
  }
  return found;
}

// Source stubs, plus the copies `copy:stubs` places in `dist/` when the build has already run.
const stubFiles = [...findStubs(stubsRoot), ...findStubs(join(packageRoot, 'dist', 'stubs'))];

/** Every stub `configure` publishes, with the path each one writes to. */
const PUBLISHED = [
  'config/authz.stub',
  'abilities/authz.stub',
  'database/migrations/create_authz_tables.stub',
];

describe('published stubs', () => {
  it('finds every stub configure publishes', () => {
    const sources = findStubs(stubsRoot).map((file) => relative('stubs', file));
    expect(sources.sort()).toEqual([...PUBLISHED].sort());
  });

  it.each(stubFiles)('%s is not empty', (file) => {
    const bytes = statSync(join(packageRoot, file)).size;
    expect(bytes, `${file} is empty — configure would publish a blank file`).toBeGreaterThan(0);
  });

  it.each(stubFiles)('%s keeps its body free of backticks and ${ }', (file) => {
    // Scoped to the BODY: the `{{{ … }}}` header is evaluated as JavaScript, so the migration stub's
    // `app.migrationsPath(\`${…}_create_authz_tables.ts\`)` is legitimate there and only there.
    const contents = readFileSync(join(packageRoot, file), 'utf8');
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

  /**
   * The check that actually proves it: build each stub through the real `app.stubs` pipeline, which is
   * what `codemods.makeUsingStub` calls from `configure.ts`. A stub that cannot render throws here
   * with the same message the user would have seen.
   */
  describe('render through the real Adonis stubs pipeline', () => {
    it.each(PUBLISHED)('%s renders to a non-empty file', async (stubPath) => {
      const app = new AppFactory().create(new URL('file:///stub-render-scratch/'));
      await app.init();
      const stubs = await app.stubs.create();

      const stub = await stubs.build(stubPath, { source: stubsRoot });
      const prepared = await stub.prepare({});

      expect(prepared.attributes.to, `${stubPath} must declare a destination`).toBeTruthy();
      expect(
        prepared.contents.length,
        `${stubPath} rendered to nothing — configure would publish a blank file`,
      ).toBeGreaterThan(0);
      expect(prepared.contents, `${stubPath} left unrendered template syntax`).not.toMatch(/\{\{/);
    });
  });
});
