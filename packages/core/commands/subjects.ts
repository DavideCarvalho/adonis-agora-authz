import { AuthzCommand, offsetPageOf } from './shared.js';

/** `--type` and `--tenant` of the subject commands, as authz MCP tool input. */
abstract class SubjectCommand extends AuthzCommand {
  declare subjectId: string;
  declare type?: string;
  declare tenant?: string;
  declare json?: boolean;

  static defineSubjectInputs(command: typeof SubjectCommand, tenant: boolean) {
    command.defineArgument('subjectId', { type: 'string', description: 'Subject (user) id' });
    command.defineFlag('type', { type: 'string', description: "Subject type (default 'user')" });
    if (tenant) {
      command.defineFlag('tenant', {
        type: 'string',
        description: 'Tenant to read in (default: the global scope, or your tenant resolver)',
      });
    }
    command.defineFlag('json', { type: 'boolean', description: 'Print JSON' });
  }

  protected toolInput(): Record<string, unknown> {
    return {
      subjectId: this.subjectRef(this.type, this.subjectId).id,
      ...(this.type !== undefined ? { subjectType: this.type } : {}),
      ...(this.tenant !== undefined ? { tenantId: this.tenant } : {}),
    };
  }

  protected tenantLabel(tenant: { id: string | null }): string {
    return tenant.id === null ? '(global)' : `tenant "${tenant.id}"`;
  }
}

/** `node ace authz:subjects:grant <subjectId> <permission> [--type]` — a direct permission grant. */
export class AuthzSubjectsGrant extends SubjectCommand {
  static override commandName = 'authz:subjects:grant';
  static override description = 'Grant a permission directly to a subject (no role)';

  declare permission: string;

  static {
    SubjectCommand.defineSubjectInputs(AuthzSubjectsGrant, false);
    AuthzSubjectsGrant.defineArgument('permission', {
      type: 'string',
      description: 'Permission name',
    });
  }

  override async run(): Promise<void> {
    const ref = this.subjectRef(this.type, this.subjectId);
    const authz = await this.service();
    await authz.store.giveSubjectPermission(ref, this.permission);
    if (this.json) return this.printJson({ subject: ref, granted: this.permission });
    this.logger.success(`Granted "${this.permission}" directly to ${ref.type}:${ref.id}`);
  }
}

/** `node ace authz:subjects:revoke <subjectId> <permission> [--type] [--force]` — drop a direct grant. */
export class AuthzSubjectsRevoke extends SubjectCommand {
  static override commandName = 'authz:subjects:revoke';
  static override description = 'Revoke a direct permission grant (role permissions stay)';

  declare permission: string;
  declare force?: boolean;

  static {
    SubjectCommand.defineSubjectInputs(AuthzSubjectsRevoke, false);
    AuthzSubjectsRevoke.defineArgument('permission', {
      type: 'string',
      description: 'Permission name, exactly as granted',
    });
    AuthzSubjectsRevoke.defineFlag('force', {
      type: 'boolean',
      description: 'Do not ask for confirmation',
    });
  }

  override async run(): Promise<void> {
    const ref = this.subjectRef(this.type, this.subjectId);
    const ok = await this.confirmed(
      this.force,
      `Revoke the direct grant "${this.permission}" from ${ref.type}:${ref.id}? Permissions from its roles stay.`,
    );
    if (!ok) return;
    const authz = await this.service();
    await authz.store.revokeSubjectPermission(ref, this.permission);
    if (this.json) return this.printJson({ subject: ref, revoked: this.permission });
    this.logger.success(`Revoked the direct grant "${this.permission}" from ${ref.type}:${ref.id}`);
  }
}

/**
 * `node ace authz:subjects:roles <subjectId> [--type] [--tenant] [--json]` — effective roles and
 * where each comes from (what `authz_list_effective_roles` returns).
 */
export class AuthzSubjectsRoles extends SubjectCommand {
  static override commandName = 'authz:subjects:roles';
  static override description = "A subject's effective roles and where each comes from";

  static {
    SubjectCommand.defineSubjectInputs(AuthzSubjectsRoles, true);
  }

  override async run(): Promise<void> {
    const result = await this.queries().effectiveRoles(this.toolInput());
    if (this.json) {
      return this.printJson({
        subject: result.subject,
        tenant: result.tenant,
        data: result.roles,
        note: result.note,
      });
    }
    const who = `${result.subject.type}:${result.subject.id}`;
    if (result.roles.length === 0) {
      this.logger.info(`${who} has no roles in ${this.tenantLabel(result.tenant)}.`);
      return;
    }
    const table = this.ui.table();
    table.head(['Role', 'Sources']);
    for (const r of result.roles) table.row([r.role, r.sources.join(', ')]);
    table.render();
    this.logger.info(`${who} in ${this.tenantLabel(result.tenant)}. ${result.note}`);
  }
}

/**
 * `node ace authz:subjects:permissions <subjectId> [--type] [--tenant] [--page] [--size] [--json]`
 * — effective permissions (what `authz_list_effective_permissions` returns).
 */
export class AuthzSubjectsPermissions extends SubjectCommand {
  static override commandName = 'authz:subjects:permissions';
  static override description = "A subject's effective permissions (roles + direct grants)";

  declare page?: number;
  declare size?: number;

  static {
    SubjectCommand.defineSubjectInputs(AuthzSubjectsPermissions, true);
    AuthzSubjectsPermissions.defineFlag('page', { type: 'number', description: 'Page, from 1' });
    AuthzSubjectsPermissions.defineFlag('size', {
      type: 'number',
      description: 'Rows per page (default 50, at most 1000)',
    });
  }

  override async run(): Promise<void> {
    const { page, size } = this.paging(this.page, this.size);
    const result = await this.queries().effectivePermissions(this.toolInput());
    const paged = offsetPageOf(
      result.permissions.map((name) => ({ name })),
      page,
      size,
    );
    if (this.json) {
      return this.printJson({ subject: result.subject, tenant: result.tenant, ...paged });
    }
    const who = `${result.subject.type}:${result.subject.id}`;
    if (paged.data.length === 0) {
      this.logger.info(`${who} has no permissions in ${this.tenantLabel(result.tenant)}.`);
      return;
    }
    const table = this.ui.table();
    table.head(['Permission']);
    for (const p of paged.data) table.row([p.name]);
    table.render();
    this.logger.info(`${who} in ${this.tenantLabel(result.tenant)}.`);
    this.pageFooter(paged.meta);
  }
}

/**
 * `node ace authz:subjects:explain <subjectId> <permission> [--type] [--tenant]
 * [--resource-type=post --resource-id=7] [--json]` — why the subject can or cannot do it (what
 * `authz_explain_check` returns). Exit code 0 either way: the verdict is the output.
 */
export class AuthzSubjectsExplain extends SubjectCommand {
  static override commandName = 'authz:subjects:explain';
  static override description = 'Explain why a subject can or cannot do something';

  declare permission: string;
  declare resourceType?: string;
  declare resourceId?: string;

  static {
    SubjectCommand.defineSubjectInputs(AuthzSubjectsExplain, true);
    AuthzSubjectsExplain.defineArgument('permission', {
      type: 'string',
      description: "The permission or ability, e.g. 'posts.edit'",
    });
    AuthzSubjectsExplain.defineFlag('resourceType', {
      type: 'string',
      flagName: 'resource-type',
      description: 'Type of the resource the check is about (with --resource-id)',
    });
    AuthzSubjectsExplain.defineFlag('resourceId', {
      type: 'string',
      flagName: 'resource-id',
      description: 'Id of the resource (with --resource-type)',
    });
  }

  override async run(): Promise<void> {
    const e = await this.queries().explainCheck({
      ...this.toolInput(),
      permission: this.permission,
      ...(this.resourceType !== undefined ? { resourceType: this.resourceType } : {}),
      ...(this.resourceId !== undefined ? { resourceId: this.resourceId } : {}),
    });
    if (this.json) return this.printJson(e);
    const verdict = e.allowed ? this.colors.green('ALLOWED') : this.colors.red('DENIED');
    const table = this.ui.table();
    table.head(['Field', 'Value']);
    table.row(['Verdict', verdict]);
    table.row(['Reason', e.message ? `${e.reason}: ${e.message}` : e.reason]);
    table.row(['Subject', `${e.subject.type}:${e.subject.id}`]);
    table.row(['Permission', e.permission]);
    table.row(['Tenant', this.tenantLabel(e.tenant)]);
    table.row(['Super-admin', e.superAdmin ? 'yes' : 'no']);
    table.row(['Decision provider', e.decisionProvider]);
    const sources = e.roleSources as Record<string, string[]>;
    table.row([
      'Effective roles',
      e.effectiveRoles
        .map((role) => {
          const from = Object.keys(sources).filter((s) => sources[s]?.includes(role));
          return `${role} (${from.join(', ')})`;
        })
        .join(', ') || '(none)',
    ]);
    table.row([
      'Granting roles',
      e.grantingRoles.map((g) => `${g.role}: ${g.matched.join(', ')}`).join('; ') || '(none)',
    ]);
    table.row(['Direct grants', e.directGrants.join(', ') || '(none)']);
    table.render();
    this.logger.info(e.note);
  }
}
