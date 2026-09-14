import type { Database } from '@adonisjs/lucid/database';
import { Adapter, BaseModel, column, manyToMany } from '@adonisjs/lucid/orm';
import type { ManyToMany } from '@adonisjs/lucid/types/relations';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authzRolesRelation } from '../src/lucid_relation.js';
import { LucidPermissionStore } from '../src/stores/lucid.js';
import { createAuthzTables } from '../src/stores/lucid-schema.js';
import { asLucidDatabase, makeMemoryDatabase } from './lucid_helpers.js';

/**
 * Runtime proof for issue #74: the pivot stores `user_id` as TEXT (polymorphic —
 * hosts may use UUIDs), but Lucid distributes pivot rows back to parents with
 * STRICT JS equality. With `increments()` ids the default `localKey: 'id'`
 * compares `'42'` (pivot) to `42` (model) and `preload('roles')` silently
 * returns []. The `localKey` option is the documented fix; these specs run the
 * real relation machinery so the silent failure can never come back unnoticed.
 */

/** The host's model over the library's roles table (a role row per `name`). */
class AuthzRoleModel extends BaseModel {
  static table = 'authz_roles';

  @column({ isPrimary: true })
  declare id: string;

  @column()
  declare name: string;
}

/** Host model with `increments()` — integer ids (the default in Adonis apps). */
class IntegerUser extends BaseModel {
  static table = 'users_int';

  @column({ isPrimary: true })
  declare id: number;

  // The recipe from the option docblock: the same column, exposed as text.
  @column({ columnName: 'id', consume: String, serializeAs: null })
  declare idAsText: string;

  @manyToMany(() => AuthzRoleModel, authzRolesRelation({ localKey: 'idAsText' }))
  declare roles: ManyToMany<typeof AuthzRoleModel>;
}

/** Host model with TEXT ids (uuid-style) — the default `localKey: 'id'` path. */
class UuidUser extends BaseModel {
  static table = 'users_uuid';

  @column({ isPrimary: true })
  declare id: string;

  @manyToMany(() => AuthzRoleModel, authzRolesRelation())
  declare roles: ManyToMany<typeof AuthzRoleModel>;
}

/** The unpatched shape: integer model WITHOUT the localKey recipe. */
class NaiveIntegerUser extends BaseModel {
  static table = 'users_int';

  @column({ isPrimary: true })
  declare id: number;

  @manyToMany(() => AuthzRoleModel, authzRolesRelation())
  declare roles: ManyToMany<typeof AuthzRoleModel>;
}

describe('authzRolesRelation — runtime preload (issue #74)', () => {
  let db: Database;

  beforeEach(async () => {
    db = makeMemoryDatabase();
    BaseModel.$adapter = new Adapter(db);
    await createAuthzTables(db);
    await db.rawQuery('CREATE TABLE users_int (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT)');
    await db.rawQuery('CREATE TABLE users_uuid (id VARCHAR(36) PRIMARY KEY, email TEXT)');
  });

  afterEach(async () => {
    await db.manager.closeAll();
  });

  it('integer ids find their roles through the localKey recipe', async () => {
    await db.rawQuery(`INSERT INTO users_int (id, email) VALUES (?, ?)`, [42, 'a@b.c']);
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.assignRole({ type: 'user', id: '42' }, 'COORDINATOR');

    const users = await IntegerUser.query().preload('roles');
    expect(users).toHaveLength(1);
    // The silent-failure fix: the pivot row reaches its parent.
    expect(users[0]!.roles.map((r) => r.name)).toEqual(['COORDINATOR']);
  });

  it('string (uuid-style) ids keep working with the default localKey', async () => {
    await db.rawQuery(`INSERT INTO users_uuid (id, email) VALUES (?, ?)`, [
      '3f0c1b2a-0000-4000-8000-000000000042',
      'a@b.c',
    ]);
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.assignRole({ type: 'user', id: '3f0c1b2a-0000-4000-8000-000000000042' }, 'ADMIN');

    const users = await UuidUser.query().preload('roles');
    expect(users[0]!.roles.map((r) => r.name)).toEqual(['ADMIN']);
  });

  it('documents why localKey exists: an integer model without it preloads empty', async () => {
    // The bug being fixed was SILENT — nothing threw. This spec is the tripwire:
    // if Lucid ever starts coercing the comparison, this assertion fails and the
    // recipe (and the docs) can be retired. Until then, an integer host MUST
    // pass localKey — that is the whole point of the option.
    await db.rawQuery(`INSERT INTO users_int (id, email) VALUES (?, ?)`, [42, 'a@b.c']);
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.assignRole({ type: 'user', id: '42' }, 'COORDINATOR');

    const users = await NaiveIntegerUser.query().preload('roles');
    expect(users[0]!.roles).toEqual([]);
  });

  it('the relation still filters by user_type and tenant at runtime', async () => {
    await db.rawQuery(`INSERT INTO users_uuid (id, email) VALUES (?, ?)`, ['u-1', 'a@b.c']);
    const store = new LucidPermissionStore(asLucidDatabase(db));
    // Global role (visible), tenant-scoped role (invisible to the default
    // global read), and another user type's row for the same id (never).
    await store.assignRole({ type: 'user', id: 'u-1' }, 'GLOBAL');
    await store.assignRole({ type: 'user', id: 'u-1' }, 'TENANT', { tenantId: 'acme' });
    await store.assignRole({ type: 'service', id: 'u-1' }, 'WRONG-TYPE');

    const [user] = await UuidUser.query().where('id', 'u-1').preload('roles');
    expect(user!.roles.map((r) => r.name)).toEqual(['GLOBAL']);
  });
});
