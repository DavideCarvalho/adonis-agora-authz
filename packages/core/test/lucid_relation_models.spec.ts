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

  // The WORKING recipe (issue #84): a `@column`-registered GETTER on the same
  // column, declared BEFORE `id`. Lucid keeps one hydration mapping per column
  // and the LAST declaration wins it — here that is `id`, which stays correct.
  // The getter still registers idAsText as an attribute (what the relation's
  // KeysExtractor reads), computing it off the hydrated id on access.
  @column({ columnName: 'id' })
  get idAsText(): string {
    return String(this.id);
  }

  @column({ isPrimary: true })
  declare id: number;

  @column()
  declare email: string;

  @manyToMany(() => AuthzRoleModel, authzRolesRelation({ localKey: 'idAsText' }))
  declare roles: ManyToMany<typeof AuthzRoleModel>;
}

/**
 * The 0.14.0-documented recipe — TWO `@column` definitions over the same
 * column, the second one stealing the hydration slot. Kept as a HAZARD
 * TRIPWIRE for issue #84: the relation works, but the model's own `id`
 * hydrates `undefined`. If a future Lucid changes per-column hydration so this
 * stops breaking, that test fails and the warning can be relaxed.
 */
class HijackedIdUser extends BaseModel {
  static table = 'users_int';

  @column({ isPrimary: true })
  declare id: number;

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
    // The silent-failure fix: the pivot row reaches its parent...
    expect(users[0]!.roles.map((r) => r.name)).toEqual(['COORDINATOR']);
    // ...and the model's own id SURVIVES hydration (#84 — the 0.14.0 recipe
    // made the first assertion true and this one undefined).
    expect(users[0]!.id).toBe(42);
    expect(users[0]!.idAsText).toBe('42');
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

  it('the getter recipe keeps normal writes working (find/save round-trip)', async () => {
    await db.rawQuery(`INSERT INTO users_int (id, email) VALUES (?, ?)`, [42, 'a@b.c']);
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.assignRole({ type: 'user', id: '42' }, 'COORDINATOR');

    const user = await IntegerUser.findOrFail(42);
    expect(user.id).toBe(42);
    user.email = 'b@b.c';
    await user.save();

    const again = await IntegerUser.query().where('id', 42).preload('roles').firstOrFail();
    expect(again.id).toBe(42);
    expect(again.email).toBe('b@b.c');
    expect(again.roles.map((r) => r.name)).toEqual(['COORDINATOR']);
  });

  it('tripwire (#84): the double-@column recipe preloads fine but leaves id undefined', async () => {
    await db.rawQuery(`INSERT INTO users_int (id, email) VALUES (?, ?)`, [42, 'a@b.c']);
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.assignRole({ type: 'user', id: '42' }, 'COORDINATOR');

    const users = await HijackedIdUser.query().preload('roles');
    // The relation looks CORRECT — this is what made the recipe ship.
    expect(users[0]!.roles.map((r) => r.name)).toEqual(['COORDINATOR']);
    // The model is broken: the later @column won the id hydration slot.
    expect(users[0]!.id).toBeUndefined();
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

/**
 * Integer pivots (`userIdType: 'integer'`): the relation needs NO recipe at
 * all — Lucid binds the model's numeric id against an INTEGER column, so the
 * DEFAULT relation matches on every dialect. This is the userIdType headline:
 * the host schema is respected instead of worked around.
 *
 * And it is not users-specific: `Team` below is an arbitrary host table with
 * an arbitrary PK name (`team_id`), proving ANY table can many-to-many with
 * roles — localKey covers names, userIdType covers types, userType covers
 * the subject kind. That is the whole OSS generality story in one spec.
 */

const INT_TABLES = {
  roles: 'ip_roles',
  permissions: 'ip_permissions',
  rolePermission: 'ip_role_permission',
  userRole: 'ip_user_role',
  userPermission: 'ip_user_permission',
} as const;

class IntPivotRole extends BaseModel {
  static table = 'ip_roles';

  @column({ isPrimary: true })
  declare id: string;

  @column()
  declare name: string;
}

/** Virgin integer model: plain id, DEFAULT relation, zero ceremony. */
class VirginIntUser extends BaseModel {
  static table = 'users_int';

  @column({ isPrimary: true })
  declare id: number;

  @column()
  declare email: string;

  @manyToMany(() => IntPivotRole, authzRolesRelation({ tables: { ...INT_TABLES } }))
  declare roles: ManyToMany<typeof IntPivotRole>;
}

/** Arbitrary host table: `teams(team_id)`, subject kind `team`. */
class Team extends BaseModel {
  static table = 'niteams';

  @column({ isPrimary: true, columnName: 'team_id' })
  declare teamId: number;

  @column()
  declare name: string;

  @manyToMany(
    () => IntPivotRole,
    authzRolesRelation({ tables: { ...INT_TABLES }, localKey: 'teamId', userType: 'team' }),
  )
  declare roles: ManyToMany<typeof IntPivotRole>;
}

describe('authzRolesRelation on INTEGER pivots (userIdType)', () => {
  let db: Database;

  beforeEach(async () => {
    db = makeMemoryDatabase();
    BaseModel.$adapter = new Adapter(db);
    await createAuthzTables(db, { tables: { ...INT_TABLES }, userIdType: 'integer' });
    await db.rawQuery('CREATE TABLE users_int (id INTEGER PRIMARY KEY, email TEXT)');
    await db.rawQuery('CREATE TABLE niteams (team_id INTEGER PRIMARY KEY, name TEXT)');
  });

  afterEach(async () => {
    await db.manager.closeAll();
  });

  function integerStore() {
    return new LucidPermissionStore(asLucidDatabase(db), {
      tables: { ...INT_TABLES },
      userIdType: 'integer',
      autoCreateSchema: false,
    });
  }

  it('a virgin integer model preloads with the DEFAULT relation, id intact', async () => {
    await db.rawQuery(`INSERT INTO users_int (id, email) VALUES (?, ?)`, [42, 'a@b.c']);
    await integerStore().assignRole({ type: 'user', id: '42' }, 'COORDINATOR');

    const users = await VirginIntUser.query().preload('roles');
    expect(users).toHaveLength(1);
    expect(users[0]!.id).toBe(42);
    expect(users[0]!.roles.map((r) => r.name)).toEqual(['COORDINATOR']);
  });

  it('ANY table works: teams(team_id) with its own subject kind', async () => {
    await db.rawQuery(`INSERT INTO niteams (team_id, name) VALUES (?, ?)`, [7, 'core']);
    const store = integerStore();
    await store.assignRole({ type: 'team', id: '7' }, 'MANAGER');
    // A user holding the same numeric id never leaks across subject kinds.
    await store.assignRole({ type: 'user', id: '7' }, 'VIEWER');

    const teams = await Team.query().preload('roles');
    expect(teams).toHaveLength(1);
    expect(teams[0]!.teamId).toBe(7);
    expect(teams[0]!.roles.map((r) => r.name)).toEqual(['MANAGER']);
  });

  it('tenant visibility holds on integer pivots too', async () => {
    await db.rawQuery(`INSERT INTO niteams (team_id, name) VALUES (?, ?)`, [7, 'core']);
    const store = integerStore();
    await store.assignRole({ type: 'team', id: '7' }, 'GLOBAL');
    await store.assignRole({ type: 'team', id: '7' }, 'TENANT', { tenantId: 'acme' });

    // The default (global) relation read sees global rows only.
    const [team] = await Team.query().where('team_id', 7).preload('roles');
    expect(team!.roles.map((r) => r.name)).toEqual(['GLOBAL']);
  });
});
