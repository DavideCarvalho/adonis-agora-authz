---
'@adonis-agora/authz': minor
---

`authz.permissionCatalog()`: every permission the app knows (the config `catalog`, `roleGrants`, the store), sorted. authz publishes it at boot on a global slot (`readAuthzCatalog()`, `AUTHZ_CATALOG_SLOT`) so `@adonis-agora/authkit-client` can publish it to the Hub for the console's "Apps it can call" picker.
