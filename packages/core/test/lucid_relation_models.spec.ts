import type { Database } from '@adonisjs/lucid/database';
import { Adapter, BaseModel, column, manyToMany } from '@adonisjs/lucid/orm';
import type { ManyToMany } from '@adonisjs/lucid/types/relations';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authzRolesRelation } from '../src/lucid_relation.js';
import { LucidPermissionStore } from '../src/stores/lucid.js';
import { createAuthzTables } from '../src/stores/lucid-schema.js';
import { asLucidDatabase, makeMemoryDatabase } from './lucid_helpers.js';

/**
 * Runtime proof for issues #74/#84: the pivot stores `user_id` as TEXT
 * (polymorphic — hosts may use UUIDs), and Lucid distributes pivot rows back to
 * parents with STRICT JS equality, so an `increments()` host compared `'42'`
 * (pivot) to `42` (model) and `preload('roles')` silently returned []. The
 * relation now normalizes that distribution itself: ANY host model — any PK
 * name, any PK type — preloads with the DEFAULT relation and zero ceremony.
 * These specs run the real relation machinery so the silent failure can never
 * come back unnoticed.
 */

/** The host's model over the library's roles table (a role row per `name`). */
class AuthzRoleModel extends BaseModel {
  static table = 'authz_roles';

  @column({ isPrimary: true })
  declare id: string;

  @column()
  declare name: string;
}

/** Host model with `increments()` — integer ids (the default in Adonis apps). Nothing else. */
class IntegerUser extends BaseModel {
  static table = 'users_int';

  @column({ isPrimary: true })
  declare id: number;

  @column()
  declare email: string;

  @manyToMany(() => AuthzRoleModel, authzRolesRelation())
  declare roles: ManyToMany<typeof AuthzRoleModel>;
}

/** Arbitrary host table: `teams(team_id)`, subject kind `team`, TEXT pivot. No localKey. */
class TextPivotTeam extends BaseModel {
  static table = 'teams_int';

  @column({ isPrimary: true, columnName: 'team_id' })
  declare teamId: number;

  @column()
  declare name: string;

  @manyToMany(() => AuthzRoleModel, authzRolesRelation({ subjectType: 'team' }))
  declare roles: ManyToMany<typeof AuthzRoleModel>;
}

/**
 * The 0.14.x recipe (`@column` getter + `localKey`). No longer needed, but a
 * host that shipped it must keep working: an explicit `localKey` is honored.
 */
class GetterRecipeUser extends BaseModel {
  static table = 'users_int';

  @column({ columnName: 'id' })
  get idAsText(): string {
    return String(this.id);
  }

  @column({ isPrimary: true })
  declare id: number;

  @manyToMany(() => AuthzRoleModel, authzRolesRelation({ localKey: 'idAsText' }))
  declare roles: ManyToMany<typeof AuthzRoleModel>;
}

/** Host model with TEXT ids (uuid-style). */
class UuidUser extends BaseModel {
  static table = 'users_uuid';

  @column({ isPrimary: true })
  declare id: string;

  @manyToMany(() => AuthzRoleModel, authzRolesRelation())
  declare roles: ManyToMany<typeof AuthzRoleModel>;
}

describe('authzRolesRelation — runtime preload on TEXT pivots (issues #74/#84)', () => {
  let db: Database;

  beforeEach(async () => {
    db = makeMemoryDatabase();
    BaseModel.$adapter = new Adapter(db);
    await createAuthzTables(db);
    await db.rawQuery('CREATE TABLE users_int (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT)');
    await db.rawQuery('CREATE TABLE teams_int (team_id INTEGER PRIMARY KEY, name TEXT)');
    await db.rawQuery('CREATE TABLE users_uuid (id VARCHAR(36) PRIMARY KEY, email TEXT)');
  });

  afterEach(async () => {
    await db.manager.closeAll();
  });

  it('an integer model preloads with the DEFAULT relation, id intact', async () => {
    await db.rawQuery(`INSERT INTO users_int (id, email) VALUES (?, ?)`, [42, 'a@b.c']);
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.assignRole({ type: 'user', id: '42' }, 'COORDINATOR');

    const users = await IntegerUser.query().preload('roles');
    expect(users).toHaveLength(1);
    expect(users[0]!.roles.map((r) => r.name)).toEqual(['COORDINATOR']);
    expect(users[0]!.id).toBe(42);
  });

  it('distributes rows to the RIGHT parent when several are preloaded at once', async () => {
    await db.rawQuery(`INSERT INTO users_int (id, email) VALUES (?, ?), (?, ?), (?, ?)`, [
      7,
      'a@b.c',
      42,
      'b@b.c',
      100,
      'c@b.c',
    ]);
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.assignRole({ type: 'user', id: '7' }, 'VIEWER');
    await store.assignRole({ type: 'user', id: '42' }, 'ADMIN');
    await store.assignRole({ type: 'user', id: '42' }, 'EDITOR');

    const users = await IntegerUser.query().orderBy('id').preload('roles');
    const byId = Object.fromEntries(users.map((u) => [u.id, u.roles.map((r) => r.name).sort()]));
    expect(byId).toEqual({ 7: ['VIEWER'], 42: ['ADMIN', 'EDITOR'], 100: [] });
  });

  it('lazy `load` on a single instance works too', async () => {
    await db.rawQuery(`INSERT INTO users_int (id, email) VALUES (?, ?)`, [42, 'a@b.c']);
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.assignRole({ type: 'user', id: '42' }, 'COORDINATOR');

    const user = await IntegerUser.findOrFail(42);
    await user.load('roles');
    expect(user.roles.map((r) => r.name)).toEqual(['COORDINATOR']);
    expect((await user.related('roles').query()).map((r) => r.name)).toEqual(['COORDINATOR']);
  });

  it('ANY table works: teams(team_id) with its own subject kind, no localKey', async () => {
    await db.rawQuery(`INSERT INTO teams_int (team_id, name) VALUES (?, ?)`, [7, 'core']);
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.assignRole({ type: 'team', id: '7' }, 'MANAGER');
    // A user holding the same numeric id never leaks across subject kinds.
    await store.assignRole({ type: 'user', id: '7' }, 'VIEWER');

    const teams = await TextPivotTeam.query().preload('roles');
    expect(teams).toHaveLength(1);
    expect(teams[0]!.teamId).toBe(7);
    expect(teams[0]!.roles.map((r) => r.name)).toEqual(['MANAGER']);
  });

  it('string (uuid-style) ids keep working', async () => {
    await db.rawQuery(`INSERT INTO users_uuid (id, email) VALUES (?, ?)`, [
      '3f0c1b2a-0000-4000-8000-000000000042',
      'a@b.c',
    ]);
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.assignRole({ type: 'user', id: '3f0c1b2a-0000-4000-8000-000000000042' }, 'ADMIN');

    const users = await UuidUser.query().preload('roles');
    expect(users[0]!.roles.map((r) => r.name)).toEqual(['ADMIN']);
  });

  it('normal writes are untouched (find/save round-trip, then preload)', async () => {
    await db.rawQuery(`INSERT INTO users_int (id, email) VALUES (?, ?)`, [42, 'a@b.c']);
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.assignRole({ type: 'user', id: '42' }, 'COORDINATOR');

    const user = await IntegerUser.findOrFail(42);
    user.email = 'b@b.c';
    await user.save();

    const again = await IntegerUser.query().where('id', 42).preload('roles').firstOrFail();
    expect(again.id).toBe(42);
    expect(again.email).toBe('b@b.c');
    expect(again.roles.map((r) => r.name)).toEqual(['COORDINATOR']);
    // The relation's own bookkeeping never leaks into the row.
    expect(Object.keys(again.$attributes).sort()).toEqual(['email', 'id']);
    expect(again.serialize()).toMatchObject({ id: 42, email: 'b@b.c' });
  });

  it('the 0.14.x getter recipe (explicit localKey) is still honored', async () => {
    await db.rawQuery(`INSERT INTO users_int (id, email) VALUES (?, ?)`, [42, 'a@b.c']);
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.assignRole({ type: 'user', id: '42' }, 'COORDINATOR');

    const users = await GetterRecipeUser.query().preload('roles');
    expect(users[0]!.roles.map((r) => r.name)).toEqual(['COORDINATOR']);
    expect(users[0]!.id).toBe(42);
  });

  it("tripwire: Lucid's own distribution still drops integer parents on TEXT pivots", async () => {
    // The normalization exists because upstream compares with `===`. If Lucid
    // ever coerces (adonisjs/lucid#1197), this fails and `normalizeDistribution`
    // can be retired. Until then it is the whole reason the relation works.
    await db.rawQuery(`INSERT INTO users_int (id, email) VALUES (?, ?)`, [42, 'a@b.c']);
    const store = new LucidPermissionStore(asLucidDatabase(db));
    await store.assignRole({ type: 'user', id: '42' }, 'COORDINATOR');

    const user = await IntegerUser.findOrFail(42);
    const relation = IntegerUser.$getRelation('roles');
    relation.boot();
    const related = await relation.eagerQuery([user], db.connection()).selectRelationKeys().exec();
    expect(related).toHaveLength(1);

    // Ours (own property on the singleton, installed by onQuery above):
    relation.setRelatedForMany([user], related);
    expect(user.roles.map((r) => r.name)).toEqual(['COORDINATOR']);
    // Lucid's (the prototype method, strict equality, reading the raw `id`):
    const upstream = Object.getPrototypeOf(relation)
      .setRelatedForMany as typeof relation.setRelatedForMany;
    const normalizedKey = relation.localKey;
    try {
      relation.localKey = 'id';
      upstream.call(relation, [user], related);
    } finally {
      relation.localKey = normalizedKey;
    }
    expect(user.roles).toEqual([]);
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
 * Integer pivots (`subjectIdType: 'integer'`): the pivot column now has the
 * host's native type, so the same DEFAULT relation keeps working — the
 * distribution normalization is type-agnostic in both directions.
 *
 * And it is not users-specific: `Team` below is an arbitrary host table with
 * an arbitrary PK name (`team_id`), proving ANY table can many-to-many with
 * roles — the PK name is picked up from the model, subjectIdType covers the
 * column type, subjectType covers the subject kind.
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
    authzRolesRelation({ tables: { ...INT_TABLES }, subjectType: 'team' }),
  )
  declare roles: ManyToMany<typeof IntPivotRole>;
}

describe('authzRolesRelation on INTEGER pivots (subjectIdType)', () => {
  let db: Database;

  beforeEach(async () => {
    db = makeMemoryDatabase();
    BaseModel.$adapter = new Adapter(db);
    await createAuthzTables(db, { tables: { ...INT_TABLES }, subjectIdType: 'integer' });
    await db.rawQuery('CREATE TABLE users_int (id INTEGER PRIMARY KEY, email TEXT)');
    await db.rawQuery('CREATE TABLE niteams (team_id INTEGER PRIMARY KEY, name TEXT)');
  });

  afterEach(async () => {
    await db.manager.closeAll();
  });

  function integerStore() {
    return new LucidPermissionStore(asLucidDatabase(db), {
      tables: { ...INT_TABLES },
      subjectIdType: 'integer',
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
