import { args, BaseCommand } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { AuthzService } from '../src/authz_service.js';

/** `node ace authz:make-role <name>` — create a role (idempotent). */
export default class AuthzMakeRole extends BaseCommand {
  static override commandName = 'authz:make-role';
  static override description = 'Create an authz role';
  static override options: CommandOptions = { startApp: true };

  @args.string({ description: 'Role name' })
  declare name: string;

  override async run(): Promise<void> {
    const authz = await this.app.container.make(AuthzService);
    await authz.store.createRole(this.name);
    this.logger.success(`Created role "${this.name}"`);
  }
}
