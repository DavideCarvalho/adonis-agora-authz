import { ListLoader } from '@adonisjs/core/ace';
import AgoraDoctor from './agora_doctor.js';
import AuthzAssign from './assign.js';
import AuthzDoctor from './authz_doctor.js';
import AuthzGrant from './grant.js';
import AuthzList from './list.js';
import AuthzMakePermission from './make_permission.js';
import AuthzMakeRole from './make_role.js';
import AuthzSync from './sync.js';

/**
 * The commands barrel for `@adonis-agora/authz`. Registered in an app's `adonisrc` via
 * `rcFile.addCommand('@adonis-agora/authz/commands')` (done by this package's
 * `configure`). A {@link ListLoader} over the authz commands and `agora:doctor` provides their
 * metadata and constructors to the ace kernel.
 */
const loader = new ListLoader([
  AuthzMakeRole,
  AuthzMakePermission,
  AuthzGrant,
  AuthzAssign,
  AuthzList,
  AuthzSync,
  AuthzDoctor,
  AgoraDoctor,
]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
