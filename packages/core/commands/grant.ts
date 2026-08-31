import { args, BaseCommand } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { AuthzService } from '../src/authz_service.js';

/** `node ace authz:grant <role> <permission>` — grant a permission to a role. */
export default class AuthzGrant extends BaseCommand {
  static override commandName = 'authz:grant';
  static override description = 'Grant a permission to a role';
  static override options: CommandOptions = { startApp: true };

  @args.string({ description: 'Role name' })
  declare role: string;

  @args.string({ description: 'Permission name' })
  declare permission: string;

  override async run(): Promise<void> {
    const authz = await this.app.container.make(AuthzService);
    await authz.store.givePermissionToRole(this.role, this.permission);
    this.logger.success(`Granted "${this.permission}" to role "${this.role}"`);
  }
}
