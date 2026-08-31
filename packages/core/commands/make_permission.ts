import { args, BaseCommand } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { AuthzService } from '../src/authz_service.js';

/** `node ace authz:make-permission <name>` — create a permission (idempotent). */
export default class AuthzMakePermission extends BaseCommand {
  static override commandName = 'authz:make-permission';
  static override description = 'Create an authz permission';
  static override options: CommandOptions = { startApp: true };

  @args.string({ description: 'Permission name (supports dotted/wildcard form, e.g. posts.edit)' })
  declare name: string;

  override async run(): Promise<void> {
    const authz = await this.app.container.make(AuthzService);
    await authz.store.createPermission(this.name);
    this.logger.success(`Created permission "${this.name}"`);
  }
}
