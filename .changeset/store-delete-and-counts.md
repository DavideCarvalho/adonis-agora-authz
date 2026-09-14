---
'@adonis-agora/authz': minor
---

`PermissionStore` gains the two operations a roles administration screen always needed (closes #78), so it no longer writes host SQL against the library's tables:

- `deleteRole(name)` — revokes the role's permission grants, removes every user assignment and deletes the role row; idempotent. Whether to refuse a still-populated role stays the host's decision (`countUsersForRole` first).
- `countUsersForRole(role, scope?)` — the "N users" KPI with `getUsersForRole`'s tenant visibility, without transferring one ref per member.
- `countUsersByRole(scope?)` — every role with its member count in one pass (unheld roles count as `0`), for a whole matrix.

All three are in the shared `runPermissionStoreContract` suite, so the memory store and any custom store follow the same semantics, and accept the #77 transaction seam.
