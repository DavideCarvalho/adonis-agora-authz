import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { type PermissionStore, toTimestamp } from '../src/store.js';
import { LucidPermissionStore } from '../src/stores/lucid.js';
import { createAuthzTables } from '../src/stores/lucid-schema.js';
import { MemoryPermissionStore } from '../src/stores/memory.js';
import { asLucidDatabase, makeMemoryDatabase } from './lucid_helpers.js';

const alice = { type: 'user', id: '1' };
const T1 = new Date('2026-01-01T10:00:00.000Z');
const T2 = new Date('2026-02-01T10:00:00.000Z');
const T3 = new Date('2026-03-01T10:00:00.000Z');

const databases: Database[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.manager.closeAll();
});

function clock() {
  let now = T1;
  return { now: () => now, set: (to: Date) => (now = to) };
}

const stores: Array<[string, (now: () => Date) => PermissionStore]> = [
  ['MemoryPermissionStore', (now) => new MemoryPermissionStore({ now })],
  [
    'LucidPermissionStore (sqlite)',
    (now) => {
      const db = makeMemoryDatabase();
      databases.push(db);
      return new LucidPermissionStore(asLucidDatabase(db), { now });
    },
  ],
];

describe.each(stores)('%s: createdAt / updatedAt', (_name, make) => {
  it('roles: created on insert, updatedAt moves only when the permission set changes', async () => {
    const c = clock();
    const store = make(c.now);
    await store.createRole('editor');
    expect(await store.listRoleRecords?.()).toEqual([
      { name: 'editor', createdAt: T1, updatedAt: T1 },
    ]);

    c.set(T2);
    await store.givePermissionToRole('editor', 'posts.edit');
    expect((await store.listRoleRecords?.())?.[0]).toEqual({
      name: 'editor',
      createdAt: T1,
      updatedAt: T2,
    });

    // Re-granting the same permission and syncing to the same set change nothing.
    c.set(T3);
    await store.givePermissionToRole('editor', 'posts.edit');
    await store.syncRolePermissions('editor', ['posts.edit']);
    expect((await store.listRoleRecords?.())?.[0]?.updatedAt).toEqual(T2);

    await store.revokePermissionFromRole('editor', 'posts.edit');
    expect((await store.listRoleRecords?.())?.[0]).toEqual({
      name: 'editor',
      createdAt: T1,
      updatedAt: T3,
    });
  });

  it('permissions carry createdAt = updatedAt', async () => {
    const c = clock();
    const store = make(c.now);
    await store.createPermission('posts.edit');
    c.set(T2);
    await store.givePermissionToRole('editor', 'posts.edit');
    expect(await store.listPermissionRecords?.()).toEqual([
      { name: 'posts.edit', createdAt: T1, updatedAt: T1 },
    ]);
  });

  it('assignments carry createdAt (append-only: no updatedAt)', async () => {
    const c = clock();
    const store = make(c.now);
    await store.assignRole(alice, 'editor', { tenantId: 't1' });
    c.set(T2);
    await store.assignRole(alice, 'editor', { tenantId: 't1' }); // idempotent: keeps T1
    await store.setSubjectRoles(alice, ['viewer'], { source: 'scim' });
    expect(await store.getRoleAssignments(alice, { tenantId: 't1' })).toEqual(
      expect.arrayContaining([
        { role: 'editor', source: 'manual', tenantId: 't1', createdAt: T1 },
        { role: 'viewer', source: 'scim', tenantId: null, createdAt: T2 },
      ]),
    );
    const listed = await store.listRoleAssignments({ subject: alice, tenantId: 't1' });
    expect(listed).toEqual([
      {
        subjectType: 'user',
        subjectId: '1',
        role: 'editor',
        source: 'manual',
        tenantId: 't1',
        createdAt: T1,
      },
    ]);
    expect(listed[0]).not.toHaveProperty('updatedAt');
  });
});

describe('LucidPermissionStore: tables from before the timestamps', () => {
  it('adds the missing columns (NULL, no backfill): old rows read without timestamps', async () => {
    const db = makeMemoryDatabase();
    databases.push(db);
    const raw = asLucidDatabase(db);
    // The pre-timestamps shape: roles/permissions with created_at only, pivots without it.
    await raw.rawQuery(
      'CREATE TABLE authz_roles (id VARCHAR(191) PRIMARY KEY, name VARCHAR(191) NOT NULL, guard VARCHAR(191), created_at DATETIME)',
    );
    await raw.rawQuery(
      'CREATE TABLE authz_permissions (id VARCHAR(191) PRIMARY KEY, name VARCHAR(191) NOT NULL, guard VARCHAR(191), created_at DATETIME)',
    );
    await raw.rawQuery(
      'CREATE TABLE authz_role_permission (role_id VARCHAR(191) NOT NULL, permission_id VARCHAR(191) NOT NULL, PRIMARY KEY (role_id, permission_id))',
    );
    await raw.rawQuery(
      "CREATE TABLE authz_subject_role (subject_type VARCHAR(191) NOT NULL, subject_id VARCHAR(191) NOT NULL, role_id VARCHAR(191) NOT NULL, tenant_id VARCHAR(191) NOT NULL DEFAULT '', source VARCHAR(64) NOT NULL DEFAULT 'manual', PRIMARY KEY (subject_type, subject_id, role_id, tenant_id, source))",
    );
    await raw.rawQuery(
      'CREATE TABLE authz_subject_permission (subject_type VARCHAR(191) NOT NULL, subject_id VARCHAR(191) NOT NULL, permission_id VARCHAR(191) NOT NULL, PRIMARY KEY (subject_type, subject_id, permission_id))',
    );
    await raw.rawQuery("INSERT INTO authz_roles (id, name) VALUES ('r1', 'legacy')");
    await raw.rawQuery(
      "INSERT INTO authz_subject_role (subject_type, subject_id, role_id) VALUES ('user', '1', 'r1')",
    );

    await createAuthzTables(raw);
    await createAuthzTables(raw); // idempotent: the columns exist now

    const store = new LucidPermissionStore(raw, { autoCreateSchema: false, now: () => T1 });
    expect(await store.listRoleRecords()).toEqual([{ name: 'legacy' }]);
    expect(await store.getRoleAssignments(alice)).toEqual([
      { role: 'legacy', source: 'manual', tenantId: null },
    ]);
    await store.giveSubjectPermission(alice, 'posts.edit');
    await store.givePermissionToRole('legacy', 'posts.edit');
    expect(await store.listRoleRecords()).toEqual([{ name: 'legacy', updatedAt: T1 }]);
  });
});

describe('toTimestamp', () => {
  it('normalises Date, Luxon-like, epoch ms and strings; null/garbage → undefined', () => {
    expect(toTimestamp(T1)).toEqual(T1);
    expect(toTimestamp({ toJSDate: () => T1 })).toEqual(T1);
    expect(toTimestamp(T1.getTime())).toEqual(T1);
    expect(toTimestamp(T1.toISOString())).toEqual(T1);
    const local = new Date(2026, 0, 1, 10, 0, 0, 0);
    expect(toTimestamp('2026-01-01 10:00:00')).toEqual(local);
    expect(toTimestamp(null)).toBeUndefined();
    expect(toTimestamp(undefined)).toBeUndefined();
    expect(toTimestamp('nope')).toBeUndefined();
  });
});
