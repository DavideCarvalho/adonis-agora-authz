import { args, BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { AuthzService } from '../src/authz_service.js';

/**
 * `node ace authz:assign <role> <userId>` — assign a role to a user. Use
 * `--type` for a polymorphic user type and `--tenant` for a tenant scope.
 */
export default class AuthzAssign extends BaseCommand {
  static override commandName = 'authz:assign';
  static override description = 'Assign a role to a user';
  static override options: CommandOptions = { startApp: true };

  @args.string({ description: 'Role name' })
  declare role: string;

  @args.string({ description: 'User id' })
  declare userId: string;

  @flags.string({ description: 'User type (polymorphic)', default: 'user' })
  declare type: string;

  @flags.string({ description: 'Tenant id (omit for the global scope)' })
  declare tenant?: string;

  override async run(): Promise<void> {
    const authz = await this.app.container.make(AuthzService);
    await authz.store.assignRole(
      { type: this.type, id: this.userId },
      this.role,
      this.tenant ? { tenantId: this.tenant } : undefined,
    );
    const where = this.tenant ? ` (tenant: ${this.tenant})` : '';
    this.logger.success(`Assigned role "${this.role}" to ${this.type}:${this.userId}${where}`);
  }
}
