import { LucidPermissionStore } from '../src/stores/lucid.js';
import type { AuthzTableNames } from '../src/stores/lucid-schema.js';
import { runPermissionStoreContract } from '../src/testing.js';
import { asLucidDatabase, makeMemoryDatabase } from './lucid_helpers.js';

let seq = 0;
function nextTables(): Required<AuthzTableNames> {
  seq += 1;
  const p = `authz_c${seq.toString(36)}_`;
  return {
    roles: `${p}roles`,
    permissions: `${p}permissions`,
    rolePermission: `${p}role_permission`,
    subjectRole: `${p}subject_role`,
    subjectPermission: `${p}subject_permission`,
  };
}

// The contract is behavior — and behavior must be identical on both subject_id
// column types. Each case gets a fresh in-memory sqlite db; the integer run
// auto-creates INTEGER pivots through the store (which exercises the
// ensureSchema → subjectIdType forwarding too).
runPermissionStoreContract(
  'LucidPermissionStore (text subject_id)',
  () => new LucidPermissionStore(asLucidDatabase(makeMemoryDatabase())),
);

for (const subjectIdType of ['integer', 'bigint'] as const) {
  runPermissionStoreContract(`LucidPermissionStore (${subjectIdType} subject_id)`, () => {
    return new LucidPermissionStore(asLucidDatabase(makeMemoryDatabase()), {
      tables: nextTables(),
      subjectIdType,
    });
  });
}
