---
name: authz-react-ui
description: >
  Mirror server authorization decisions in an Inertia + React frontend with
  @adonis-agora/authz-react — the server-side buildAuthzShare() from
  @adonis-agora/authz-react/server wired into Inertia sharedData, typing the
  prop with AuthzSharedProps, and the client primitives useAuthz / useCan /
  <Can permission | role fallback> plus AuthzProvider for provider-less
  contexts (tests, Storybook) and the client-safe matchers
  permissionMatches / permissionSatisfied. Use when hiding UI controls by
  permission or role, pushing effective grants from AdonisJS to React,
  testing gated components without the Inertia tree, or debugging a Can gate
  that never renders.
metadata:
  type: core
  library: "@adonis-agora/authz-react"
  library_version: "0.2.1"
  framework: react
sources:
  - DavideCarvalho/adonis-authz:docs/react.mdx
  - DavideCarvalho/adonis-authz:packages/react/src/index.ts
  - DavideCarvalho/adonis-authz:packages/react/src/use_authz.ts
  - DavideCarvalho/adonis-authz:packages/react/src/components/can.tsx
---

This skill pairs with the server's `authz-decisions` skill: the share is built
from `effectiveRoles` / `effectivePermissions`, so UI gating matches what the
server would decide.

# Frontend parity: buildAuthzShare → useCan / <Can>

The client never re-computes authorization. The server resolves the user's
effective grants once and ships them as an Inertia shared prop; every client
primitive decides from that snapshot. Fail-closed everywhere: no share (logged
out, outside `<App>`, before mount) means `useCan()` is `false` and `<Can>`
renders its fallback.

## Setup

```sh
npm i @adonis-agora/authz-react
```

Peers (`@adonis-agora/authz`, `@inertiajs/react`, `react`, `react-dom`) are
already present in an Inertia + React Adonis app.

```ts title="config/inertia.ts"
import { defineConfig } from '@adonisjs/inertia'
import authz from '@adonis-agora/authz/services/main'
import { buildAuthzShare } from '@adonis-agora/authz-react/server'

export default defineConfig({
  sharedData: {
    // ctx.auth.user works with @adonisjs/auth; use ctx.auth.getUser() for authkit.
    authz: (ctx) => buildAuthzShare(authz, ctx.auth?.user ?? null),
  },
})
```

```tsx title="resources/js/pages/posts/index.tsx"
import { Can, useCan, useAuthz } from '@adonis-agora/authz-react'

export default function PostsIndex() {
  const canCreate = useCan('posts.create') // wildcard-aware
  const { roles } = useAuthz()             // raw snapshot

  return (
    <div>
      {canCreate && <a href="/posts/new">New post</a>}

      <Can permission="posts.edit">
        <button>Edit</button>
      </Can>

      <Can role="admin" fallback={<span>Read-only</span>}>
        <button>Delete</button>
      </Can>

      {roles.includes('admin') && <AdminBadge />}
    </div>
  )
}
```

## Core patterns

### Type the shared prop

`AuthzSharedProps` carries an index signature, so intersect it with your own
shared props.

```ts title="types/inertia.ts"
import type { AuthzSharedProps } from '@adonis-agora/authz-react'

export interface AppPageProps extends AuthzSharedProps {
  user: { id: number; fullName: string } | null
}
```

Source: `docs/react.mdx`

### Provider-less testing and non-Inertia shells

Inside a live Inertia app the primitives read `usePage().props.authz`
directly — no provider needed. An explicit `<AuthzProvider>` value wins over
the shared prop, which makes tests trivial: `usePage()` throws outside an
Inertia `<App>` and `useAuthz` catches that, falling back to the context value.

```tsx title="posts-index.test.tsx"
import { render, screen } from '@testing-library/react'
import { AuthzProvider } from '@adonis-agora/authz-react'
import PostsIndex from '#pages/posts/index'

test('shows the edit button for editors', () => {
  render(
    <AuthzProvider value={{ roles: ['editor'], permissions: ['posts.*'] }}>
      <PostsIndex />
    </AuthzProvider>,
  )
  expect(screen.getByText('Edit')).toBeVisible()
})
```

Source: `docs/react.mdx`, `packages/react/src/use_authz.ts`

### Client-safe matcher for ad-hoc sets

The same wildcard matcher as the server, with no server import — gate against
a permission set you fetched yourself.

```tsx
import { permissionMatches, permissionSatisfied } from '@adonis-agora/authz-react'

permissionMatches('posts.*', 'posts.edit')                          // true
permissionSatisfied(['billing.*', 'posts.read'], 'billing.refund') // true
```

Source: `docs/react.mdx`

## Common mistakes

### HIGH Importing the server helper from the client barrel

`buildAuthzShare` lives under `/server` precisely so the server engine never
lands in the browser bundle; the root barrel deliberately excludes it.

Wrong:

```ts
import { buildAuthzShare } from '@adonis-agora/authz-react'; // wrong entry point
```

Correct:

```ts
import { buildAuthzShare, type AuthzShare } from '@adonis-agora/authz-react/server';
```

Mechanism: the package ships two entry points — the client-safe root barrel
and `/server`; importing across the seam drags `@adonis-agora/authz`'s service
types (and any transitive server code) into client bundles.

Source: `docs/react.mdx` (intro), `packages/react/src/index.ts` (barrel comment)

### MEDIUM Passing permission AND role to <Can> expecting an AND

When both props are supplied, `permission` takes precedence and `role` is never
consulted — the gate is broader than the author intended, not narrower.

Wrong:

```tsx
<Can permission="billing.manage" role="auditor">
  <BillingSettings /> {/* role ignored — permission alone decides */}
</Can>
```

Correct:

```tsx
<Can permission="billing.manage">
  <Can role="auditor">
    <BillingSettings /> {/* nested Cans compose as AND */}
  </Can>
</Can>
```

Mechanism: `<Can>` checks `permissionSatisfied(permissions, permission)` first
and falls back to `roles.includes(role)` only when `permission` is undefined.

Source: `docs/react.mdx` (<Can> warn Callout), `packages/react/src/components/can.tsx`

### MEDIUM Mocking usePage in tests instead of mounting AuthzProvider

`usePage()` throws outside an Inertia `<App>`; `useAuthz` catches that and
prefers an explicit provider. Mocking Inertia internals fights the designed
seam and breaks on internals changes.

Wrong:

```tsx
vi.mock('@inertiajs/react', () => ({ usePage: () => ({ props: { authz: {...} } }) }));
render(<Can permission="posts.edit"><button>Edit</button></Can>);
```

Correct:

```tsx
render(
  <AuthzProvider value={{ roles: [], permissions: ['posts.*'] }}>
    <Can permission="posts.edit"><button>Edit</button></Can>
  </AuthzProvider>,
);
```

Mechanism: read precedence is context value ?? shared prop ?? empty share, and
the try/catch around `usePage` exists exactly so components render under a bare
provider.

Source: `docs/react.mdx` (<AuthzProvider> section), `packages/react/src/use_authz.ts`
