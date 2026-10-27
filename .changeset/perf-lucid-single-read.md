---
"@adonis-agora/authz": patch
---

perf(lucid): `getPermissionsForSubject` reads role-derived and direct grants in one `UNION ALL` query instead of two (role-derived names still come first), and `subjectHasPermission` checks both sources in one `EXISTS … OR EXISTS …` query instead of up to two. A request's first permission check now costs 2 queries instead of 3.
