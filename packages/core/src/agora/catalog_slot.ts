/**
 * The permission catalog authz publishes for the other Agora libs, on a well-known global symbol
 * slot so they read it without importing authz (`@adonis-agora/authkit-client` publishes it to the
 * Hub for the console's "Apps it can call" picker).
 */

/** The symbol slot authz writes its catalog reader into. */
export const AUTHZ_CATALOG_SLOT = Symbol.for('@adonis-agora/authz:catalog');

/** What the slot holds. */
export interface AuthzCatalogReader {
  /** Every permission this app knows (`AuthzService.permissionCatalog`). */
  permissions(): Promise<string[]>;
}

/** Publish `reader` on the slot (the provider does it at boot). */
export function publishAuthzCatalog(reader: AuthzCatalogReader): void {
  (globalThis as Record<symbol, unknown>)[AUTHZ_CATALOG_SLOT] = reader;
}

/** The published reader, or `undefined` when authz is not booted in this process. */
export function readAuthzCatalog(): AuthzCatalogReader | undefined {
  const slot = (globalThis as Record<symbol, unknown>)[AUTHZ_CATALOG_SLOT];
  return slot != null &&
    typeof slot === 'object' &&
    typeof (slot as AuthzCatalogReader).permissions === 'function'
    ? (slot as AuthzCatalogReader)
    : undefined;
}
