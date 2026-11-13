import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AceFactory } from '@adonisjs/core/factories/core/ace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthzAssignmentsAdd,
  AuthzAssignmentsList,
  AuthzAssignmentsRemove,
} from '../commands/assignments.js';
import loader from '../commands/main.js';
import {
  AuthzPermissionsList,
  AuthzRolesGrant,
  AuthzRolesList,
  AuthzRolesRevoke,
} from '../commands/roles.js';
import {
  AuthzSubjectsExplain,
  AuthzSubjectsGrant,
  AuthzSubjectsPermissions,
  AuthzSubjectsRevoke,
  AuthzSubjectsRoles,
} from '../commands/subjects.js';
import { AuthzService } from '../src/authz_service.js';
import { MemoryPermissionStore } from '../src/stores/memory.js';

type Kernel = Awaited<ReturnType<typeof AceFactory.prototype.make>>;
type Logged = { logger: { getLogs(): { message: string }[] } };

describe('authz commands', () => {
  let appRoot: string;
  let store: MemoryPermissionStore;
  let service: AuthzService;
  const tty = process.stdin.isTTY;
  const ana = { type: 'user', id: 'ana' };

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'authz-commands-'));
    await writeFile(
      join(appRoot, 'adonisrc.ts'),
      `import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({})\n`,
    );
    store = new MemoryPermissionStore();
    await store.givePermissionToRole('editor', 'posts.*');
    await store.givePermissionToRole('billing', 'invoices.read');
    await store.createPermission('audit.read');
    await store.assignRole(ana, 'editor');
    await store.assignRole(ana, 'billing', { tenantId: 'acme' });
    await store.assignRole({ type: 'user', id: 'bob' }, 'editor', { source: 'scim' });
    service = new AuthzService({ store, roleGrants: { support: ['tickets.*'] } });
  });

  afterEach(async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    await rm(appRoot, { recursive: true, force: true });
  });

  function noTty() {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  }

  async function exec(command: unknown, argv: string[]) {
    const kernel: Kernel = await new AceFactory().make(pathToFileURL(`${appRoot}/`), {
      importer: (filePath) => import(filePath),
    });
    await kernel.app.init();
    await kernel.app.boot();
    kernel.app.container.bindValue(AuthzService, service);
    kernel.app.config.set('authz', {
      roleGrants: { support: ['tickets.*'] },
      catalog: { roles: { editor: ['posts.*'], viewer: ['posts.view'] } },
    });
    kernel.ui.switchMode('raw');
    const instance = await kernel.create(command as never, argv);
    await instance.exec();
    return instance;
  }

  const printed = (i: Logged) =>
    i.logger
      .getLogs()
      .map((l) => l.message)
      .join('\n');
  const output = (i: { ui: Logged }) => printed(i.ui);
  const json = (i: Logged) => JSON.parse(printed(i));

  it('registers every command under authz:<noun>:<verb>', async () => {
    const names = (await loader.getMetaData()).map((c) => c.commandName).sort();
    expect(names).toEqual([
      'agora:doctor',
      'authz:assignments:add',
      'authz:assignments:list',
      'authz:assignments:remove',
      'authz:doctor',
      'authz:make-permission',
      'authz:make-role',
      'authz:permissions:list',
      'authz:roles:grant',
      'authz:roles:list',
      'authz:roles:revoke',
      'authz:subjects:explain',
      'authz:subjects:grant',
      'authz:subjects:permissions',
      'authz:subjects:revoke',
      'authz:subjects:roles',
      'authz:sync',
    ]);
  });

  describe('roles', () => {
    it('lists roles from the store, roleGrants and the catalog, as a table', async () => {
      const i = await exec(AuthzRolesList, []);
      expect(i.exitCode).toBe(0);
      const out = output(i);
      expect(out).toContain('editor');
      expect(out).toContain('support');
      expect(out).toContain('missing: role');
    });

    it('--json is an offset page of the authz_list_roles rows; --drift filters', async () => {
      const all = json(await exec(AuthzRolesList, ['--json', '--size=2']));
      expect(all.meta).toEqual({ total: 4, perPage: 2, currentPage: 1, lastPage: 2, firstPage: 1 });
      expect(all.data.map((r: { role: string }) => r.role)).toEqual(['billing', 'editor']);
      const drift = json(await exec(AuthzRolesList, ['--json', '--drift']));
      expect(drift.data).toEqual([
        {
          role: 'viewer',
          inStore: false,
          permissions: [],
          roleGrants: [],
          catalog: ['posts.view'],
          missingInStore: ['posts.view'],
          drift: true,
        },
      ]);
    });

    it('refuses a bad --size with exit code 1', async () => {
      const i = await exec(AuthzRolesList, ['--size=0']);
      expect(i.exitCode).toBe(1);
      expect(printed(i)).toContain('--size must be');
    });

    it('grants a permission to a role', async () => {
      const i = await exec(AuthzRolesGrant, ['viewer', 'posts.view', '--json']);
      expect(json(i)).toEqual({ role: 'viewer', permissions: ['posts.view'] });
      expect(await store.getRolePermissions('viewer')).toEqual(['posts.view']);
    });

    it('revokes with --force, refuses without a terminal, no-ops when not granted', async () => {
      noTty();
      const refused = await exec(AuthzRolesRevoke, ['editor', 'posts.*']);
      expect(refused.exitCode).toBe(1);
      expect(printed(refused)).toContain('--force');
      expect(await store.getRolePermissions('editor')).toEqual(['posts.*']);

      const done = await exec(AuthzRolesRevoke, ['editor', 'posts.*', '--force', '--json']);
      expect(done.exitCode).toBe(0);
      expect(json(done)).toEqual({ role: 'editor', permissions: [] });

      const noop = await exec(AuthzRolesRevoke, ['editor', 'posts.*']);
      expect(noop.exitCode).toBe(0);
      expect(printed(noop)).toContain('nothing to revoke');
    });

    it('asks in a terminal and stops on no', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      const kernel: Kernel = await new AceFactory().make(pathToFileURL(`${appRoot}/`), {
        importer: (filePath) => import(filePath),
      });
      await kernel.app.init();
      await kernel.app.boot();
      kernel.app.container.bindValue(AuthzService, service);
      kernel.ui.switchMode('raw');
      const i = await kernel.create(AuthzRolesRevoke as never, ['editor', 'posts.*']);
      i.prompt
        .trap('Revoke "posts.*" from role "editor"? Everyone holding the role loses it.')
        .reject();
      await i.exec();
      expect(i.exitCode).toBe(1);
      expect(await store.getRolePermissions('editor')).toEqual(['posts.*']);
    });

    it('lists permissions', async () => {
      const i = json(await exec(AuthzPermissionsList, ['--json']));
      expect(i.data).toEqual([
        { name: 'audit.read' },
        { name: 'invoices.read' },
        { name: 'posts.*' },
      ]);
      expect(i.meta.total).toBe(3);
      expect(output(await exec(AuthzPermissionsList, []))).toContain('invoices.read');
    });
  });

  describe('assignments', () => {
    it('lists with filters', async () => {
      const all = json(await exec(AuthzAssignmentsList, ['--json']));
      expect(all.meta.total).toBe(3);
      const acme = json(await exec(AuthzAssignmentsList, ['--json', '--tenant=acme']));
      expect(acme.data).toEqual([
        {
          subjectType: 'user',
          subjectId: 'ana',
          role: 'billing',
          source: 'manual',
          tenantId: 'acme',
        },
      ]);
      const scim = json(await exec(AuthzAssignmentsList, ['--json', '--global', '--source=scim']));
      expect(scim.data.map((a: { subjectId: string }) => a.subjectId)).toEqual(['bob']);
      const ana = json(
        await exec(AuthzAssignmentsList, ['--json', '--subject=ana', '--role=editor']),
      );
      expect(ana.data).toHaveLength(1);
      expect(output(await exec(AuthzAssignmentsList, []))).toContain('user:bob');
    });

    it('refuses --tenant with --global', async () => {
      const i = await exec(AuthzAssignmentsList, ['--tenant=acme', '--global']);
      expect(i.exitCode).toBe(1);
    });

    it('adds an assignment in a tenant with a source', async () => {
      const i = await exec(AuthzAssignmentsAdd, [
        'editor',
        'carol',
        '--tenant=acme',
        '--source=scim',
      ]);
      expect(i.exitCode).toBe(0);
      expect(
        await store.getRoleAssignments({ type: 'user', id: 'carol' }, { tenantId: 'acme' }),
      ).toEqual([{ role: 'editor', source: 'scim', tenantId: 'acme' }]);
    });

    it('removes with --force, refuses without a terminal, no-ops when absent', async () => {
      noTty();
      const refused = await exec(AuthzAssignmentsRemove, ['billing', 'ana', '--tenant=acme']);
      expect(refused.exitCode).toBe(1);
      expect(await store.getRolesForSubject(ana, { tenantId: 'acme' })).toContain('billing');

      const done = await exec(AuthzAssignmentsRemove, [
        'billing',
        'ana',
        '--tenant=acme',
        '--force',
        '--json',
      ]);
      expect(done.exitCode).toBe(0);
      expect(json(done).assignments).toEqual([
        { subjectType: 'user', subjectId: 'ana', role: 'editor', source: 'manual', tenantId: null },
      ]);

      const noop = await exec(AuthzAssignmentsRemove, ['billing', 'ana', '--tenant=acme']);
      expect(noop.exitCode).toBe(0);
      expect(printed(noop)).toContain('nothing to remove');
    });
  });

  describe('subjects', () => {
    it('grants and revokes a direct permission', async () => {
      await exec(AuthzSubjectsGrant, ['ana', 'reports.export']);
      expect(await store.subjectHasPermission(ana, 'reports.export')).toBe(true);
      noTty();
      expect((await exec(AuthzSubjectsRevoke, ['ana', 'reports.export'])).exitCode).toBe(1);
      const done = await exec(AuthzSubjectsRevoke, ['ana', 'reports.export', '--force', '--json']);
      expect(json(done)).toEqual({ subject: ana, revoked: 'reports.export' });
      expect(await store.subjectHasPermission(ana, 'reports.export')).toBe(false);
    });

    it('lists effective roles with sources, per tenant', async () => {
      const global = json(await exec(AuthzSubjectsRoles, ['ana', '--json']));
      expect(global.data).toEqual([{ role: 'editor', sources: ['store'] }]);
      expect(global.tenant).toEqual({ id: null, from: 'global' });
      const acme = json(await exec(AuthzSubjectsRoles, ['ana', '--tenant=acme', '--json']));
      expect(acme.data.map((r: { role: string }) => r.role).sort()).toEqual(['billing', 'editor']);
      expect(output(await exec(AuthzSubjectsRoles, ['ana']))).toContain('editor');
    });

    it('lists effective permissions as an offset page', async () => {
      const acme = json(await exec(AuthzSubjectsPermissions, ['ana', '--tenant=acme', '--json']));
      expect(acme.data).toEqual([{ name: 'invoices.read' }, { name: 'posts.*' }]);
      expect(acme.meta.total).toBe(2);
      expect(acme.tenant).toEqual({ id: 'acme', from: 'explicit' });
    });

    it('explains a check', async () => {
      const allowed = json(await exec(AuthzSubjectsExplain, ['ana', 'posts.edit', '--json']));
      expect(allowed).toMatchObject({
        allowed: true,
        reason: 'permission',
        grantingRoles: [{ role: 'editor', matched: ['posts.*'] }],
      });
      const denied = await exec(AuthzSubjectsExplain, ['ana', 'invoices.read']);
      expect(denied.exitCode).toBe(0);
      expect(output(denied)).toContain('DENIED');
    });

    it('refuses a half resource', async () => {
      const i = await exec(AuthzSubjectsExplain, ['ana', 'posts.edit', '--resource-type=post']);
      expect(i.exitCode).toBe(1);
      expect(printed(i)).toContain('resourceType');
    });
  });
});
