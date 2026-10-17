import type { Database } from '@adonisjs/lucid/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LucidPermissionStore } from '../src/stores/lucid.js';
import { AUTHZ_TABLES, createAuthzTables } from '../src/stores/lucid-schema.js';
import { asLucidDatabase } from './lucid_helpers.js';

/**
 * An install from before 0.15, when the subject pivots were `authz_user_role` /
 * `authz_user_permission` with `user_type` / `user_id`: 0.15 renamed them, and booting it used to
 * stand up new, empty pivots next to the old ones — every subject silently lost its roles.
 * Registered by the SQLite spec and once per real dialect in the testcontainers spec.
 */
export function runLegacySubjectPivotScenarios(label: string, getDb: () => Database) {
  describe(`pre-0.15 subject pivots (${label})`, () => {
    const alice = { type: 'user', id: '1' };
    const bob = { type: 'user', id: '2' };
    const legacyRole = 'authz_user_role';
    const legacyPermission = 'authz_user_permission';
    const backups = [`${legacyRole}_pre_subject`, `${legacyPermission}_pre_subject`];

    const sql = (q: string) => getDb().rawQuery(q);
    const store = (tables?: { subjectRole?: string; subjectPermission?: string }) =>
      new LucidPermissionStore(asLucidDatabase(getDb()), {
        autoCreateSchema: false,
        ...(tables ? { tables } : {}),
      });
    const boot = (tables?: { subjectRole?: string; subjectPermission?: string }) =>
      createAuthzTables(asLucidDatabase(getDb()), tables ? { tables } : {});

    async function tableNames(): Promise<string[]> {
      const dialect = getDb().connection().dialect.name;
      const q = /sqlite/i.test(dialect)
        ? `SELECT name FROM sqlite_master WHERE type = 'table'`
        : /mysql/i.test(dialect)
          ? 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()'
          : 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()';
      const result = await getDb().rawQuery(q);
      const rows = Array.isArray(result)
        ? Array.isArray(result[0])
          ? result[0]
          : result
        : ((result as { rows?: unknown[] }).rows ?? []);
      return (rows as Record<string, unknown>[]).map((r) => String(r.name ?? r.NAME));
    }

    /** Turn a pivot into its pre-0.15 shape and name, keeping its rows. */
    async function toLegacy(table: string, legacy: string, rest: string, restDdl: string) {
      await sql(`CREATE TABLE ${legacy} (
        user_type VARCHAR(191) NOT NULL,
        user_id VARCHAR(191) NOT NULL,
        ${restDdl}
      )`);
      await sql(
        `INSERT INTO ${legacy} (user_type, user_id, ${rest}) SELECT subject_type, subject_id, ${rest} FROM ${table}`,
      );
      await sql(`DROP TABLE ${table}`);
    }

    /** A ≤ 0.14 database: alice is an editor and holds `posts.delete` directly. */
    async function legacyInstall() {
      await boot();
      const s = store();
      await s.givePermissionToRole('editor', 'posts.edit');
      await s.assignRole(alice, 'editor');
      await s.giveSubjectPermission(alice, 'posts.delete');
      await toLegacy(
        AUTHZ_TABLES.subjectRole,
        legacyRole,
        'role_id, tenant_id',
        `role_id VARCHAR(191) NOT NULL,
        tenant_id VARCHAR(191) NOT NULL DEFAULT '',
        PRIMARY KEY (user_type, user_id, role_id, tenant_id)`,
      );
      await toLegacy(
        AUTHZ_TABLES.subjectPermission,
        legacyPermission,
        'permission_id',
        `permission_id VARCHAR(191) NOT NULL,
        PRIMARY KEY (user_type, user_id, permission_id)`,
      );
    }

    beforeEach(async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const existing = await tableNames();
      for (const table of [
        ...Object.values(AUTHZ_TABLES),
        legacyRole,
        legacyPermission,
        ...backups,
        'legacy_custom_roles',
      ]) {
        if (existing.includes(table)) await sql(`DROP TABLE ${table}`);
      }
      return () => vi.restoreAllMocks();
    });

    it('renames an install still on ≤ 0.14, keeping every role and permission', async () => {
      await legacyInstall();

      await boot();

      const s = store();
      expect(await s.getRolesForSubject(alice)).toEqual(['editor']);
      expect(await s.subjectHasPermission(alice, 'posts.edit')).toBe(true);
      expect(await s.subjectHasPermission(alice, 'posts.delete')).toBe(true);
      const tables = await tableNames();
      expect(tables).not.toContain(legacyRole);
      expect(tables).not.toContain(legacyPermission);
      // A second boot finds nothing left to do.
      await boot();
      expect(await s.getRolesForSubject(alice)).toEqual(['editor']);
    });

    it('renames the user_* columns of a pivot that kept its own table name', async () => {
      await boot({ subjectRole: 'legacy_custom_roles' });
      const s = store({ subjectRole: 'legacy_custom_roles' });
      await s.assignRole(alice, 'editor');
      await sql('ALTER TABLE legacy_custom_roles RENAME COLUMN subject_type TO user_type');
      await sql('ALTER TABLE legacy_custom_roles RENAME COLUMN subject_id TO user_id');

      await boot({ subjectRole: 'legacy_custom_roles' });

      expect(await s.getRolesForSubject(alice)).toEqual(['editor']);
    });

    it('recovers the roles an earlier 0.15+ boot left behind, once', async () => {
      await legacyInstall();
      // What 0.15–0.18 did on this database: new, empty pivots next to the old ones (made here by
      // booting with the old tables out of sight). Then the app went on, and bob got a role.
      await sql(`ALTER TABLE ${legacyRole} RENAME TO hidden_role`);
      await sql(`ALTER TABLE ${legacyPermission} RENAME TO hidden_permission`);
      await boot();
      await sql(`ALTER TABLE hidden_role RENAME TO ${legacyRole}`);
      await sql(`ALTER TABLE hidden_permission RENAME TO ${legacyPermission}`);
      const s = store();
      await s.assignRole(bob, 'viewer');

      await boot();

      expect(await s.getRolesForSubject(alice)).toEqual(['editor']);
      expect(await s.subjectHasPermission(alice, 'posts.delete')).toBe(true);
      expect(await s.getRolesForSubject(bob)).toEqual(['viewer']);
      const tables = await tableNames();
      expect(tables).toEqual(expect.arrayContaining(backups));
      expect(tables).not.toContain(legacyRole);

      // Revoked after the recovery, it stays revoked: the old rows are not copied again.
      await s.removeRole(alice, 'editor');
      await boot();
      expect(await s.getRolesForSubject(alice)).toEqual([]);
    });
  });
}
