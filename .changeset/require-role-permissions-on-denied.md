---
'@adonis-agora/authz': minor
---

`AuthzRoleMiddleware` (`requireRole`) opens by permission and lets the host decide the denial response (closes #76):

- `permissions: ['admin.*']` — any-of, wildcard-aware in either direction (a granted `admin.*` opens route `admin.users`; a route `admin.*` opens for a grant of `admin.users`), so an area admits roles created at runtime without any route listing them. Only consulted when `roles` did not match — a role pass costs no extra query.
- `onDenied: (ctx, { roles, permissions }) => unknown` — redirect to the user's own area with a flash, custom 403, anything; receives what was already resolved, overrides `deniedRedirect`/`deniedMessage`.
- `roles` is no longer required — at least one of `roles`/`permissions` must be given; neither (or two empty lists) throws a configuration error at request time.

Defaults are unchanged when neither new option is passed.
