/**
 * Type-resolution shim for the skill examples, never built nor published (excluded in
 * tsconfig.json). Intent type-checks `@adonis-agora/authz/scope` in `skills/` from this
 * package's source at `src/scope.ts`; the published subpath is the `exports` entry in
 * package.json, `src/scope_kit.ts`.
 */
export * from './scope_kit.js';
