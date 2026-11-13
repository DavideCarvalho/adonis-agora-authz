import type { RoleAssignmentFilter } from '../src/store.js';
import { AuthzCommand, offsetPageOf } from './shared.js';

/**
 * `node ace authz:assignments:list [--subject=42] [--type=user] [--role=editor,admin]
 * [--tenant=acme | --global] [--source=manual] [--page] [--size] [--json]` — stored role
 * assignments (who holds which role, where, from which source).
 */
export class AuthzAssignmentsList extends AuthzCommand {
  static override commandName = 'authz:assignments:list';
  static override description = 'List stored role assignments (subject, role, tenant, source)';

  declare subject?: string;
  declare type?: string;
  declare role?: string;
  declare tenant?: string;
  declare global?: boolean;
  declare source?: string;
  declare page?: number;
  declare size?: number;
  declare json?: boolean;

  static {
    AuthzAssignmentsList.defineFlag('subject', {
      type: 'string',
      description: 'Only this subject id',
    });
    AuthzAssignmentsList.defineFlag('type', {
      type: 'string',
      description: "Subject type of --subject (default 'user')",
    });
    AuthzAssignmentsList.defineFlag('role', {
      type: 'string',
      description: 'Only these roles, comma separated',
    });
    AuthzAssignmentsList.defineFlag('tenant', {
      type: 'string',
      description: "Only this tenant's assignments (global ones are not included)",
    });
    AuthzAssignmentsList.defineFlag('global', {
      type: 'boolean',
      description: 'Only global assignments',
    });
    AuthzAssignmentsList.defineFlag('source', {
      type: 'string',
      description: "Only this source ('manual', 'scim', …)",
    });
    AuthzAssignmentsList.defineFlag('page', { type: 'number', description: 'Page, from 1' });
    AuthzAssignmentsList.defineFlag('size', {
      type: 'number',
      description: 'Rows per page (default 50, at most 1000)',
    });
    AuthzAssignmentsList.defineFlag('json', { type: 'boolean', description: 'Print JSON' });
  }

  override async run(): Promise<void> {
    if (this.tenant !== undefined && this.global) {
      throw new Error('--tenant and --global exclude each other');
    }
    if (this.type !== undefined && this.subject === undefined) {
      throw new Error('--type needs --subject');
    }
    const { page, size } = this.paging(this.page, this.size);
    const roles = this.role
      ?.split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    const filter: RoleAssignmentFilter = {
      ...(this.subject !== undefined ? { subject: this.subjectRef(this.type, this.subject) } : {}),
      ...(roles !== undefined ? { role: roles } : {}),
      ...(this.tenant !== undefined ? { tenantId: this.tenant } : {}),
      ...(this.global ? { tenantId: null } : {}),
      ...(this.source !== undefined ? { source: this.source } : {}),
    };
    const authz = await this.service();
    const result = offsetPageOf(await authz.store.listRoleAssignments(filter), page, size);
    if (this.json) return this.printJson(result);
    if (result.data.length === 0) {
      this.logger.info('No role assignments.');
      return;
    }
    const table = this.ui.table();
    table.head(['Subject', 'Role', 'Tenant', 'Source']);
    for (const a of result.data) {
      table.row([`${a.subjectType}:${a.subjectId}`, a.role, a.tenantId ?? '(global)', a.source]);
    }
    table.render();
    this.pageFooter(result.meta);
  }
}

/** Flags shared by `assignments:add` and `assignments:remove`. */
abstract class AssignmentChange extends AuthzCommand {
  declare role: string;
  declare subjectId: string;
  declare type?: string;
  declare tenant?: string;
  declare source?: string;
  declare json?: boolean;

  static defineAssignmentInputs(command: typeof AssignmentChange, verb: string) {
    command.defineArgument('role', { type: 'string', description: 'Role name' });
    command.defineArgument('subjectId', { type: 'string', description: 'Subject (user) id' });
    command.defineFlag('type', {
      type: 'string',
      description: "Subject type (default 'user')",
    });
    command.defineFlag('tenant', {
      type: 'string',
      description: 'Tenant id (omit for the global scope)',
    });
    command.defineFlag('source', {
      type: 'string',
      description:
        verb === 'add'
          ? "Who owns the assignment (default 'manual')"
          : 'Only the assignment of this source (default: every source)',
    });
    command.defineFlag('json', {
      type: 'boolean',
      description: "Print the subject's assignments afterwards as JSON",
    });
  }

  protected scope() {
    return {
      ...(this.tenant !== undefined ? { tenantId: this.tenant } : {}),
      ...(this.source !== undefined ? { source: this.source } : {}),
    };
  }

  protected where(): string {
    return this.tenant !== undefined ? ` in tenant "${this.tenant}"` : ' (global)';
  }

  /** This subject's stored assignments of the role, in exactly the given tenant (and source). */
  protected async matching() {
    const authz = await this.service();
    return authz.store.listRoleAssignments({
      subject: this.subjectRef(this.type, this.subjectId),
      role: this.role,
      tenantId: this.tenant ?? null,
      ...(this.source !== undefined ? { source: this.source } : {}),
    });
  }

  protected async printAfter() {
    const authz = await this.service();
    this.printJson({
      subject: this.subjectRef(this.type, this.subjectId),
      assignments: await authz.store.listRoleAssignments({
        subject: this.subjectRef(this.type, this.subjectId),
      }),
    });
  }
}

/**
 * `node ace authz:assignments:add <role> <subjectId> [--type=user] [--tenant=acme]
 * [--source=manual]` — assign a role to a subject (idempotent).
 */
export class AuthzAssignmentsAdd extends AssignmentChange {
  static override commandName = 'authz:assignments:add';
  static override description = 'Assign a role to a subject';

  static {
    AssignmentChange.defineAssignmentInputs(AuthzAssignmentsAdd, 'add');
  }

  override async run(): Promise<void> {
    const authz = await this.service();
    const ref = this.subjectRef(this.type, this.subjectId);
    await authz.store.assignRole(ref, this.role, this.scope());
    if (this.json) return this.printAfter();
    this.logger.success(`Assigned role "${this.role}" to ${ref.type}:${ref.id}${this.where()}`);
  }
}

/**
 * `node ace authz:assignments:remove <role> <subjectId> [--type] [--tenant] [--source] [--force]`
 * — remove a role assignment in exactly that tenant scope; without `--source`, from every source.
 */
export class AuthzAssignmentsRemove extends AssignmentChange {
  static override commandName = 'authz:assignments:remove';
  static override description = 'Remove a role from a subject';

  declare force?: boolean;

  static {
    AssignmentChange.defineAssignmentInputs(AuthzAssignmentsRemove, 'remove');
    AuthzAssignmentsRemove.defineFlag('force', {
      type: 'boolean',
      description: 'Do not ask for confirmation',
    });
  }

  override async run(): Promise<void> {
    const ref = this.subjectRef(this.type, this.subjectId);
    const rows = await this.matching();
    if (rows.length === 0) {
      if (this.json) return this.printAfter();
      this.logger.info(
        `${ref.type}:${ref.id} has no role "${this.role}"${this.where()}${this.source !== undefined ? ` from source "${this.source}"` : ''}: nothing to remove.`,
      );
      return;
    }
    const sources = rows.map((r) => r.source).join(', ');
    const ok = await this.confirmed(
      this.force,
      `Remove role "${this.role}" from ${ref.type}:${ref.id}${this.where()} (source: ${sources})?`,
    );
    if (!ok) return;
    const authz = await this.service();
    await authz.store.removeRole(ref, this.role, this.scope());
    if (this.json) return this.printAfter();
    this.logger.success(`Removed role "${this.role}" from ${ref.type}:${ref.id}${this.where()}`);
  }
}
