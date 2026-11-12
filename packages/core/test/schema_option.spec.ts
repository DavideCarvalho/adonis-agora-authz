import { describe, expect, it } from 'vitest';
import AuthzProvider from '../providers/authz_provider.js';
import type { AgoraDoctorCheck } from '../src/doctor/agora_doctor.js';
import { authzDoctorChecks } from '../src/doctor/checks.js';
import { authzRolesRelation } from '../src/lucid_relation.js';
import { assertStoreSchema, stores } from '../src/stores/factory.js';
import { LucidPermissionStore } from '../src/stores/lucid.js';
import {
  AUTHZ_TABLES,
  assertSchemaName,
  createAuthzTables,
  dropAuthzTables,
  type LucidDatabase,
  qualifyTable,
} from '../src/stores/lucid-schema.js';
import { asLucidDatabase, makeMemoryDatabase } from './lucid_helpers.js';

/** A client that records every statement and answers like an empty database. */
function recorder(dialect: string) {
  const sql: string[] = [];
  const client: LucidDatabase = {
    dialect: { name: dialect },
    async rawQuery(text: string) {
      sql.push(text);
      return dialect === 'mysql' ? [[], []] : { rows: [] };
    },
    async transaction<T>(callback: (trx: LucidDatabase) => Promise<T>) {
      return callback(client);
    },
  };
  return { client, sql };
}

/** Every reference to an authz table in `sql`, with what precedes it. */
function tableRefs(sql: string): string[] {
  const names = Object.values(AUTHZ_TABLES).join('|');
  return [...sql.matchAll(new RegExp(`([\\w"\`.]*?)(?<![\\w])(${names})(?![\\w])`, 'g'))].map(
    (m) => m[0],
  );
}

async function exercise(store: LucidPermissionStore) {
  const alice = { type: 'user', id: '1' };
  await store.createRole('editor');
  await store.givePermissionToRole('editor', 'posts.edit');
  await store.revokePermissionFromRole('editor', 'posts.edit');
  await store.assignRole(alice, 'editor');
  await store.removeRole(alice, 'editor');
  await store.setSubjectRoles(alice, ['editor']);
  await store.getRoleAssignments(alice);
  await store.listRoleAssignments({ role: 'editor', tenantId: 't' });
  await store.giveSubjectPermission(alice, 'x');
  await store.revokeSubjectPermission(alice, 'x');
  await store.getRolesForSubject(alice, { tenantId: 't' });
  await store.getSubjectsForRole('editor');
  await store.countSubjectsForRole('editor');
  await store.countSubjectsByRole();
  await store.getPermissionsForSubject(alice);
  await store.subjectHasPermission(alice, 'x');
  await store.listRoles();
  await store.listPermissions();
  await store.getRolePermissions('editor');
  await store.getPermissionsForRoles(['editor']);
  await store.syncRolePermissions('editor', ['a']);
  await store.deleteRole('editor');
  await store.removeSubject(alice);
}

describe('schema option', () => {
  it('validates the name', () => {
    for (const ok of ['authz', '_a', 'a$1', 'A'.repeat(63)]) expect(assertSchemaName(ok)).toBe(ok);
    for (const bad of ['', '1a', 'a.b', 'a-b', 'a"b', 'A'.repeat(64), 'a b']) {
      expect(() => assertSchemaName(bad)).toThrow(/invalid schema/);
    }
    expect(() => stores.lucid({ schema: 'a.b' })).toThrow(/invalid schema/);
    expect(() => authzRolesRelation({ schema: 'x;drop' })).toThrow(/invalid schema/);
  });

  it('quotes the schema and the table as two identifiers', () => {
    expect(qualifyTable('authz_roles', 'authz', 'postgres')).toBe('"authz".authz_roles');
    expect(qualifyTable('authz_roles', 'authz', 'mysql2')).toBe('`authz`.authz_roles');
    expect(qualifyTable('authz_roles', undefined, 'postgres')).toBe('authz_roles');
  });

  for (const dialect of ['postgres', 'mysql']) {
    it(`${dialect}: every statement names the schema (data, DDL, catalog lookups)`, async () => {
      const { client, sql } = recorder(dialect);
      const store = new LucidPermissionStore(client, { schema: 'authz' });
      await exercise(store);
      await exercise(store.withClient(client));
      await dropAuthzTables(client, { schema: 'authz' });
      const q = dialect === 'mysql' ? '`authz`.' : '"authz".';

      const refs = sql.flatMap(tableRefs);
      expect(refs.length).toBeGreaterThan(50);
      // Index names (`authz_roles_name_uq`) are not table references; everything else is qualified.
      const unqualified = refs.filter((r) => !r.startsWith(q));
      expect(unqualified).toEqual([]);
      expect(sql.some((s) => /CREATE (SCHEMA|DATABASE) IF NOT EXISTS/.test(s))).toBe(true);
      expect(sql.join('\n')).not.toMatch(/current_schema|DATABASE\(\)|search_path/i);
    });
  }

  it('without schema: the same statements as before, unqualified', async () => {
    const { client, sql } = recorder('postgres');
    await exercise(new LucidPermissionStore(client));
    expect(sql.join('\n')).not.toMatch(/"authz"|CREATE SCHEMA|pg_namespace/);
  });

  it('a host transaction view keeps the schema', async () => {
    const root = recorder('postgres');
    const trx = recorder('postgres');
    const store = new LucidPermissionStore(root.client, { schema: 'authz' });
    await store.withClient(trx.client).listRoles();
    await store.listRoles({ client: trx.client });
    expect(trx.sql).toEqual([
      'SELECT name FROM "authz".authz_roles ORDER BY name',
      'SELECT name FROM "authz".authz_roles ORDER BY name',
    ]);
  });

  it('SQLite + schema fails loud (store, createAuthzTables, boot)', async () => {
    const db = makeMemoryDatabase();
    try {
      const lucid = asLucidDatabase(db);
      expect(() => new LucidPermissionStore(lucid, { schema: 'authz' })).toThrow(
        /needs a Postgres or MySQL\/MariaDB connection, but this one is "(better-)?sqlite3?"/,
      );
      await expect(createAuthzTables(lucid, { schema: 'authz' })).rejects.toThrow(/no schemas/);

      const app = {
        container: { make: async () => db },
        config: {
          get: (key: string, fallback: unknown) =>
            key === 'authz'
              ? { default: 'lucid', stores: { lucid: stores.lucid({ schema: 'authz' }) } }
              : fallback,
        },
      };
      await expect(
        assertStoreSchema(stores.lucid({ schema: 'authz' }), { app } as never),
      ).rejects.toThrow(/no schemas/);
      const provider = new AuthzProvider(app as never);
      await expect(provider.boot()).rejects.toThrow(/schema: "authz"/);
      // Without schema the same app boots.
      await expect(assertStoreSchema(stores.lucid(), { app } as never)).resolves.toBeUndefined();
    } finally {
      await db.manager.closeAll();
    }
  });

  it('the relation reads the schema-qualified pivot', () => {
    expect(authzRolesRelation({ schema: 'authz' }).pivotTable).toBe('authz.authz_subject_role');
    expect(authzRolesRelation().pivotTable).toBe('authz_subject_role');
    expect(() =>
      authzRolesRelation({ schema: 'authz', tables: { subjectRole: 'other.pivot' } }),
    ).toThrow(/unsafe SQL identifier/);
  });

  it('doctor: authz.schema only when a schema is configured', async () => {
    expect(authzDoctorChecks().map((c) => c.id)).not.toContain('authz.schema');
    const check = authzDoctorChecks({ schema: true }).find(
      (c) => c.id === 'authz.schema',
    ) as AgoraDoctorCheck;
    expect(check.cost).toBe('deep');

    const values = new Map<string, unknown>();
    const app = (authz: unknown) => ({
      config: { get: (k: string, d: unknown) => (k === 'authz' ? authz : d) },
      container: {
        singleton: () => {},
        hasBinding: (key: string) => values.has(key),
        bindValue: (key: string, value: unknown) => values.set(key, value),
        make: async (key: string) =>
          key === 'lucid.db'
            ? { connection: () => ({ dialect: { name: 'postgres' } }) }
            : values.get(key),
      },
    });
    await new AuthzProvider(app({ stores: { lucid: stores.lucid() } }) as never).boot();
    const ids = () =>
      (values.get('agora.doctor') as { checks: AgoraDoctorCheck[] }).checks.map((c) => c.id);
    expect(ids()).not.toContain('authz.schema');
    values.clear();
    await new AuthzProvider(
      app({ stores: { lucid: stores.lucid({ schema: 'authz' }) } }) as never,
    ).boot();
    expect(ids()).toContain('authz.schema');
  });
});
