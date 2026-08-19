/**
 * Type-checks every PUBLISHED stub the way a consumer app does: a scratch AdonisJS-shaped app that
 * depends on `@adonis-agora/authz` and `@adonisjs/*` by NAME, with each stub rendered into the file it
 * actually generates, compiled by a real `tsc --noEmit` under NodeNext + strict.
 *
 * WHY THIS EXISTS. A `.stub` is a template that no tsconfig `include` reaches, so it is invisible to
 * every other gate in this repo. The package's own typecheck compiles `src/` against the library's OWN
 * types, which are trivially happy with themselves — nothing anywhere looks at the code `configure`
 * hands a user. That is how `@adonis-agora/agent` shipped a migration whose `up()` did not compile in a
 * consumer app: its structural `rawQuery` declared `bindings?: unknown[]`, not assignable in either
 * direction to Lucid's `RawQueryBindings`, so no per-connection client satisfied it. Its whole suite
 * stayed green.
 *
 * Resolution matters as much as compilation. The scratch app reaches the package through its `exports`
 * map, so what is checked is the PUBLISHED `dist/**\/*.d.ts` a consumer installs — not `src/`, which a
 * check run inside this repo would otherwise pick up. Removing a symbol from the root export map is
 * invisible to the package's own typecheck (its imports are relative) and fails here.
 *
 * Rendering goes through the REAL `app.stubs` pipeline — the same one `codemods.makeUsingStub` runs —
 * rather than a regex approximation. The approximation is precisely what let a whole separate defect
 * survive: all three stubs carried backticks in their doc comments, which terminate Tempura's template
 * literal, so `configure` threw before writing anything while every hand-rolled renderer was happy.
 *
 * Exits 0 on success; on failure prints tsc's diagnostics and exits non-zero. Driven by
 * `stub-typecheck.spec.ts`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppFactory } from '@adonisjs/core/factories/app';

const pkgRoot = fileURLToPath(new URL('../../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const stubsRoot = join(pkgRoot, 'stubs');

/**
 * Every stub `configure` publishes. All three emit typed TypeScript that imports from the package, so
 * all three would break a consumer's build if a published signature drifted.
 */
const STUBS = [
  'config/authz.stub',
  'abilities/authz.stub',
  'database/migrations/create_authz_tables.stub',
];

/**
 * Mirror the package's `node_modules` into the scratch app, entry by entry, so the stubs resolve every
 * peer they import (`@adonisjs/lucid`, `@adonisjs/core`) plus anything the published declarations
 * transitively reference. Scoped directories are recreated as real directories so
 * `@adonis-agora/authz` can be added alongside without writing into the package's own tree.
 *
 * Mirroring wholesale rather than naming a fixed list keeps the harness from rotting: a new peer is
 * picked up automatically instead of failing here as a confusing missing-types error.
 */
function linkDependencies(appRoot) {
  const from = join(pkgRoot, 'node_modules');
  const to = join(appRoot, 'node_modules');
  mkdirSync(to, { recursive: true });

  for (const entry of readdirSync(from)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      mkdirSync(join(to, entry), { recursive: true });
      for (const scoped of readdirSync(join(from, entry))) {
        symlinkSync(join(from, entry, scoped), join(to, entry, scoped));
      }
      continue;
    }
    symlinkSync(join(from, entry), join(to, entry));
  }

  // The package under test, resolved BY NAME through its `exports` map → dist/**/*.d.ts.
  mkdirSync(join(to, '@adonis-agora'), { recursive: true });
  symlinkSync(pkgRoot, join(to, '@adonis-agora/authz'));
}

const appRoot = mkdtempSync(join(tmpdir(), 'authz-stub-typecheck-'));
try {
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({ name: 'authz-stub-typecheck-app', type: 'module', private: true }, null, 2),
  );
  linkDependencies(appRoot);

  // Render through the real pipeline. `attributes.to` is the destination the generator computes, so
  // each file lands exactly where a consumer would find it — including the migration's timestamp.
  const app = new AppFactory().create(new URL(`file://${appRoot}/`));
  await app.init();
  const stubs = await app.stubs.create();

  for (const stubPath of STUBS) {
    const prepared = await (await stubs.build(stubPath, { source: stubsRoot })).prepare({});

    const leftover = prepared.contents.match(/\{\{.*?\}\}/);
    if (leftover) {
      throw new Error(`unrendered template syntax ${leftover[0]} left in ${stubPath}`);
    }

    // `to` is absolute and already inside appRoot (the app factory was rooted there).
    const target = prepared.attributes.to;
    if (relative(appRoot, target).startsWith('..')) {
      throw new Error(`${stubPath} renders outside the scratch app: ${target}`);
    }
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, prepared.contents);
  }

  /**
   * An AdonisJS app's own compiler options: NodeNext + strict, which is what `@adonisjs/tsconfig`
   * sets. Both matter — NodeNext is what makes the package's `exports` map (and therefore its subpath
   * declarations) the thing being resolved, and `strict` is what turns a variance mismatch from a
   * silent widening into a hard error. `topLevelAwait` support comes from the ES2022 target, which the
   * abilities stub needs.
   */
  writeFileSync(
    join(appRoot, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022'],
          types: ['node'],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          esModuleInterop: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
        include: ['database/**/*.ts', 'config/**/*.ts', 'app/**/*.ts'],
      },
      null,
      2,
    ),
  );

  try {
    execFileSync(join(repoRoot, 'node_modules/.bin/tsc'), ['-p', join(appRoot, 'tsconfig.json')], {
      cwd: appRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (error) {
    console.error('stub typecheck: FAILED — a published stub does not compile in a consumer app');
    console.error(error.stdout ?? '');
    console.error(error.stderr ?? '');
    process.exit(1);
  }
} finally {
  rmSync(appRoot, { recursive: true, force: true });
}

console.log(`stub typecheck: OK (${STUBS.length} stubs)`);
