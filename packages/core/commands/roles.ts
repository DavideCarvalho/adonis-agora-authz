import { AuthzCommand, offsetPageOf } from './shared.js';

/**
 * `node ace authz:roles:list [--role=editor] [--drift] [--page=1] [--size=50] [--json]` — every
 * known role with its permissions in the store, in `roleGrants` and in the `catalog`, and whether
 * the store is missing something the catalog declares (what `authz_list_roles` returns).
 */
export class AuthzRolesList extends AuthzCommand {
  static override commandName = 'authz:roles:list';
  static override description = 'List roles with their permissions (store, roleGrants, catalog)';

  declare role?: string;
  declare drift?: boolean;
  declare page?: number;
  declare size?: number;
  declare json?: boolean;

  static {
    AuthzRolesList.defineFlag('role', { type: 'string', description: 'Only this role' });
    AuthzRolesList.defineFlag('drift', {
      type: 'boolean',
      description: 'Only catalog roles with something missing from the store (fix: authz:sync)',
    });
    AuthzRolesList.defineFlag('page', { type: 'number', description: 'Page, from 1' });
    AuthzRolesList.defineFlag('size', {
      type: 'number',
      description: 'Rows per page (default 50, at most 1000)',
    });
    AuthzRolesList.defineFlag('json', { type: 'boolean', description: 'Print JSON' });
  }

  override async run(): Promise<void> {
    const { page, size } = this.paging(this.page, this.size);
    const rows = await this.queries().roles({
      ...(this.role !== undefined ? { role: this.role } : {}),
      ...(this.drift ? { drift: true } : {}),
    });
    const result = offsetPageOf(rows, page, size);
    if (this.json) return this.printJson(result);
    if (result.data.length === 0) {
      this.logger.info(this.drift ? 'No drift: the store has every catalog role.' : 'No roles.');
      return;
    }
    const table = this.ui.table();
    table.head(['Role', 'Store permissions', 'roleGrants', 'Catalog', 'Drift']);
    for (const r of result.data) {
      table.row([
        r.role,
        r.inStore ? r.permissions.join(', ') || '(none)' : '(not in store)',
        r.roleGrants.join(', '),
        r.catalog === null ? '' : r.catalog.join(', '),
        r.drift ? `missing: ${r.inStore ? r.missingInStore.join(', ') : 'role'}` : '',
      ]);
    }
    table.render();
    this.pageFooter(result.meta);
  }
}

/** `node ace authz:roles:grant <role> <permission>` — grant a permission to a role. */
export class AuthzRolesGrant extends AuthzCommand {
  static override commandName = 'authz:roles:grant';
  static override description = 'Grant a permission to a role (creating either as needed)';

  declare role: string;
  declare permission: string;
  declare json?: boolean;

  static {
    AuthzRolesGrant.defineArgument('role', { type: 'string', description: 'Role name' });
    AuthzRolesGrant.defineArgument('permission', {
      type: 'string',
      description: 'Permission name (wildcards like posts.* allowed)',
    });
    AuthzRolesGrant.defineFlag('json', {
      type: 'boolean',
      description: "Print the role's permissions afterwards as JSON",
    });
  }

  override async run(): Promise<void> {
    const authz = await this.service();
    await authz.store.givePermissionToRole(this.role, this.permission);
    if (this.json) {
      return this.printJson({
        role: this.role,
        permissions: (await authz.store.getRolePermissions(this.role)).sort(),
      });
    }
    this.logger.success(`Granted "${this.permission}" to role "${this.role}"`);
  }
}

/** `node ace authz:roles:revoke <role> <permission> [--force]` — take a permission from a role. */
export class AuthzRolesRevoke extends AuthzCommand {
  static override commandName = 'authz:roles:revoke';
  static override description = 'Revoke a permission from a role';

  declare role: string;
  declare permission: string;
  declare force?: boolean;
  declare json?: boolean;

  static {
    AuthzRolesRevoke.defineArgument('role', { type: 'string', description: 'Role name' });
    AuthzRolesRevoke.defineArgument('permission', {
      type: 'string',
      description: 'Permission name, exactly as granted',
    });
    AuthzRolesRevoke.defineFlag('force', {
      type: 'boolean',
      description: 'Do not ask for confirmation',
    });
    AuthzRolesRevoke.defineFlag('json', {
      type: 'boolean',
      description: "Print the role's permissions afterwards as JSON",
    });
  }

  override async run(): Promise<void> {
    const authz = await this.service();
    const before = await authz.store.getRolePermissions(this.role);
    if (!before.includes(this.permission)) {
      if (this.json) return this.printJson({ role: this.role, permissions: before.sort() });
      this.logger.info(`Role "${this.role}" has no "${this.permission}": nothing to revoke.`);
      return;
    }
    const ok = await this.confirmed(
      this.force,
      `Revoke "${this.permission}" from role "${this.role}"? Everyone holding the role loses it.`,
    );
    if (!ok) return;
    await authz.store.revokePermissionFromRole(this.role, this.permission);
    if (this.json) {
      return this.printJson({
        role: this.role,
        permissions: (await authz.store.getRolePermissions(this.role)).sort(),
      });
    }
    this.logger.success(`Revoked "${this.permission}" from role "${this.role}"`);
  }
}

/** `node ace authz:permissions:list [--page] [--size] [--json]` — every permission in the store. */
export class AuthzPermissionsList extends AuthzCommand {
  static override commandName = 'authz:permissions:list';
  static override description = 'List every permission in the store';

  declare page?: number;
  declare size?: number;
  declare json?: boolean;

  static {
    AuthzPermissionsList.defineFlag('page', { type: 'number', description: 'Page, from 1' });
    AuthzPermissionsList.defineFlag('size', {
      type: 'number',
      description: 'Rows per page (default 50, at most 1000)',
    });
    AuthzPermissionsList.defineFlag('json', { type: 'boolean', description: 'Print JSON' });
  }

  override async run(): Promise<void> {
    const { page, size } = this.paging(this.page, this.size);
    const authz = await this.service();
    const names = [...(await authz.store.listPermissions())].sort();
    const result = offsetPageOf(
      names.map((name) => ({ name })),
      page,
      size,
    );
    if (this.json) return this.printJson(result);
    if (result.data.length === 0) {
      this.logger.info('No permissions.');
      return;
    }
    const table = this.ui.table();
    table.head(['Permission']);
    for (const p of result.data) table.row([p.name]);
    table.render();
    this.pageFooter(result.meta);
  }
}
