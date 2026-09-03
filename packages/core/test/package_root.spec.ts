import { describe, expect, it, vi } from 'vitest';

// Simulate an app where the OPTIONAL peer `@adonisjs/bouncer` is not usable: the
// module resolves to nothing the integration can work with. (Throwing from the mock
// factory is not a faithful stand-in — the test runner wraps factory throws in its
// own error, while real Node raises `ERR_MODULE_NOT_FOUND` with the missing
// specifier. Absent exports exercise the same production path that matters: the
// root stays importable and the integration fails helpfully when called. Note the
// keys must exist with `undefined` values — the runner itself throws on access to
// keys the factory never returned, which would mask the error under test.)
vi.mock('@adonisjs/bouncer', () => ({
  Bouncer: undefined,
  AuthorizationResponse: undefined,
}));

/**
 * The `node ace add` / `node ace configure` contract.
 *
 * Adonis resolves the configure hook by importing the package MAIN entry and reading
 * `configure` off the module namespace — the `./configure` subpath alone is never
 * consulted. Two defects shipped here through that hole, both invisible inside the
 * monorepo (devDependencies install every peer) and both only visible to a consumer:
 *
 * 1. The main entry did not re-export `configure`, so `ace configure` silently did
 *    nothing (`The module does not export the configure hook`).
 * 2. The main entry statically imported the OPTIONAL peer `@adonisjs/bouncer`
 *    (via `./bouncer/abilities.js`), so in an app without bouncer installed the import
 *    itself threw `ERR_MODULE_NOT_FOUND` — which `ace configure` misreported as
 *    `Cannot find module "@adonis-agora/authz". Make sure to install it`, followed by
 *    `Unable to configure @adonis-agora/authz` from `ace add`.
 *
 * Every assertion below runs with the optional peer unusable, i.e. under the exact
 * conditions of the reported failure.
 */
describe('package root without the optional @adonisjs/bouncer peer', () => {
  it('stays importable and exposes the `configure` hook', async () => {
    const root = await import('../src/index.js');
    expect(typeof root.configure).toBe('function');
  });

  it('keeps the abilities API importable from the root (stub/docs contract)', async () => {
    const root = await import('../src/index.js');
    expect(typeof root.defineAuthzAbilities).toBe('function');
    expect(typeof root.authzAbilities).toBe('function');
  });

  it('throws an actionable error when the bouncer integration is used without the peer', async () => {
    const { defineAuthzAbilities, authzAbilities } = await import('../src/bouncer/abilities.js');
    expect(() => defineAuthzAbilities({} as never)).toThrowError(
      /@adonisjs\/bouncer.*not installed.*node ace add @adonisjs\/bouncer/,
    );
    await expect(authzAbilities(async () => ({}) as never)).rejects.toThrow(/@adonisjs\/bouncer/);
  });
});
