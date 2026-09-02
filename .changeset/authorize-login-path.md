---
"@adonis-agora/authz": minor
---

`authorizeByRoles` gains `loginPath`: send an expired session to your login page instead of a
dead end.

```ts
// config/telescope_ui.ts — e o mesmo em durable / media / payments
authorize: authorizeByRoles({ roles: ['ADMIN'], loginPath: '/auth/login' })
```

Until now a visitor with no session got the dashboard's own denial: a "401 — you need to be
signed in" page with **no way out**. The dashboard could say login was missing; it could not
ask for login. Getting in meant walking over to the app by hand, letting the session refresh,
and coming back — for every dashboard, in every app.

With `loginPath`, that visitor is redirected to `/auth/login?redirect=%2Ftelescope` and the
login route sends them back. Every `@adonis-agora` dashboard (telescope, durable, media,
payments) already honors a `location` written by the hook before writing its own denial, so
one option fixes all of them at once — no change needed in the dashboard libs.

Two deliberate limits:

- **Only when there is no session.** Someone signed in who merely lacks the role still gets
  `403`. Redirecting them would loop: the login is already done, and returning yields the same
  denial.
- **Only page navigations** (`Accept: text/html`). A `302` on the dashboard's own API call
  would hand the SPA's `fetch` the login HTML where it expects JSON, trading an honest `401`
  for a parse error.

`returnToParam` (default `'redirect'`) names the query parameter, for login routes that read a
different one. The return-to is built from the request URL — server-known, so no open redirect
is introduced here; your login route should still validate what it receives, since it is public
and anyone can craft the link by hand.

Additive: behavior is unchanged when `loginPath` is omitted.
