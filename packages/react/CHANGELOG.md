# @adonis-agora/authz-react

## 0.3.1

### Patch Changes

- [#186](https://github.com/DavideCarvalho/adonis-agora-authz/pull/186) [`91a115d`](https://github.com/DavideCarvalho/adonis-agora-authz/commit/91a115d2a12e828001e3a06a5e3cfd6a0fd51b50) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - perf: `useCan` and `<Can>` compile the share's `permissions` array once (exact grants in a `Set`, only wildcard grants pre-split) and reuse it for every gate that reads the same array, instead of scanning and splitting every grant per gate per render. Matching semantics are unchanged.

## 0.3.0

### Minor Changes

- [#160](https://github.com/DavideCarvalho/adonis-agora-authz/pull/160) [`1afb3a1`](https://github.com/DavideCarvalho/adonis-agora-authz/commit/1afb3a1e84996cbe740fd955d96ef7d197b49cc0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Drop Node.js 20 and 22: `engines.node` is now `>=24`. Node 20 reached end-of-life on 2026-04-30, and AdonisJS 7, which these packages require as a peer, needs Node 24 or later (`@adonisjs/core` declares `engines.node >=24.0.0`). The supported lines are the ones Node still maintains that AdonisJS 7 accepts: 24 and 26, both tested in CI.

## 0.2.2

### Patch Changes

- [#43](https://github.com/DavideCarvalho/adonis-agora-authz/pull/43) [`e0ee489`](https://github.com/DavideCarvalho/adonis-agora-authz/commit/e0ee489ceb2f94ad484149c14646332e3fca30f8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ship TanStack Intent AI-agent skills with both packages: six SKILL.md files
  (`packages/core/skills/authz-*`, `packages/react/skills/authz-react-ui`) plus
  repo-level `_artifacts/` (domain map, skill spec, skill tree), validated by
  `intent validate` and a new `.github/workflows/check-skills.yml`. Skills are
  published via the new `skills/` entry in each package's `files` array.

## 0.2.1

### Patch Changes

- [#32](https://github.com/DavideCarvalho/adonis-agora-authz/pull/32) [`bd9ce3e`](https://github.com/DavideCarvalho/adonis-agora-authz/commit/bd9ce3e66e8abef73216e26d73cc3af994289a86) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix `engines.node`, which was published as the exact version `v26.7.0` instead
  of a supported range. Every consumer on any other Node version got an engine
  warning on install, and installs under `engine-strict` failed outright. The
  field is back to `>=20.6.0`, and Renovate no longer treats it as a pinnable
  dependency.

## 0.2.0

### Version reset to 0.x

This package started at `0.1.0` but a changesets peer-dependency quirk majored it on every
`@adonis-agora/authz` release (`0.1.0 → 1.0.0 → 2.0.0 → 3.0.0`), overstating its maturity. The
package is pre-1.0. The `@adonis-agora/authz` peer range is now `>=0.9.0 <1`, so authz 0.x minors
no longer force a major here. The `1.0.0`–`3.0.1` versions are deprecated; use `0.x`.

### Patch Changes

- Updated dependencies [[`ad2dff0`](https://github.com/DavideCarvalho/adonis-authz/commit/ad2dff0bb7a12943e47ae05d72604ec754523589)]:
  - @adonis-agora/authz@0.10.0

## 3.0.0

### Patch Changes

- Updated dependencies [[`afe5d3b`](https://github.com/DavideCarvalho/adonis-authz/commit/afe5d3b2fe0fbfed65f2645d120be16c307c6afe)]:
  - @adonis-agora/authz@0.9.0

## 2.0.0

### Patch Changes

- Updated dependencies [[`e2cb451`](https://github.com/DavideCarvalho/adonis-authz/commit/e2cb45176db474b40b51bedf85277074f95b77a0)]:
  - @adonis-agora/authz@0.8.0

## 1.0.0

### Patch Changes

- Updated dependencies [[`c9d2d0f`](https://github.com/DavideCarvalho/adonis-authz/commit/c9d2d0f4025a3b9063ad9fadaaed071a6f9cebdc)]:
  - @adonis-agora/authz@0.7.0

## 0.1.0

### Minor Changes

- [#9](https://github.com/DavideCarvalho/adonis-authz/pull/9) [`50ec77f`](https://github.com/DavideCarvalho/adonis-authz/commit/50ec77f0b81a7deeec089e286b877bcfb20148d2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New package: `@adonis-agora/authz-react`. React/Inertia bindings for `@adonis-agora/authz`:

  - `buildAuthzShare(authz, user, scope?)` (server, `@adonis-agora/authz-react/server`) — builds the Inertia share from `AuthzService#effectiveRoles`/`#effectivePermissions` (store ∪ roleGrants ∪ resolveRoles ∪ context), the same union `can()` uses, so client-side gating matches the server decision.
  - `AuthzProvider`/`useAuthz` (client) — read the share from an optional `<AuthzProvider>` context, falling back to `usePage().props.authz`.
  - `useCan(permission)` and `<Can permission="..."> | <Can role="...">` — wildcard-aware permission gating (a client-safe port of the core's matcher) and exact role gating, fail-closed with no share.

  Ships as two subpaths (`.` for the client bundle, `./server` for the Inertia middleware) so the server-only `AuthzService` type import never reaches the client bundle.
