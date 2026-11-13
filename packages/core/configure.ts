import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @adonis-agora/authz` — auto-wires the package:
 *
 * 1. registers the service provider in `adonisrc.ts`;
 * 2. registers the ace commands barrel (`authz:make-role`, `authz:make-permission`,
 *    `authz:roles:*`, `authz:permissions:list`, `authz:assignments:*`, `authz:subjects:*`,
 *    `authz:sync`, `authz:doctor`);
 * 3. publishes `config/authz.ts`;
 * 4. publishes the Bouncer abilities into `app/abilities/authz.ts`;
 * 5. publishes the Lucid migration for the RBAC tables (run `node ace
 *    migration:run`; not needed if you use the `memory` store or set
 *    `autoCreateSchema`).
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@adonis-agora/authz/authz_provider');
    rcFile.addCommand('@adonis-agora/authz/commands');
  });

  await codemods.makeUsingStub(stubsRoot, 'config/authz.stub', {});
  await codemods.makeUsingStub(stubsRoot, 'abilities/authz.stub', {});
  await codemods.makeUsingStub(stubsRoot, 'database/migrations/create_authz_tables.stub', {});
}
