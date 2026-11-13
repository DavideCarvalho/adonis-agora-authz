import { ListLoader } from '@adonisjs/core/ace';
import AgoraDoctor from './agora_doctor.js';
import {
  AuthzAssignmentsAdd,
  AuthzAssignmentsList,
  AuthzAssignmentsRemove,
} from './assignments.js';
import AuthzDoctor from './authz_doctor.js';
import AuthzMakePermission from './make_permission.js';
import AuthzMakeRole from './make_role.js';
import {
  AuthzPermissionsList,
  AuthzRolesGrant,
  AuthzRolesList,
  AuthzRolesRevoke,
} from './roles.js';
import {
  AuthzSubjectsExplain,
  AuthzSubjectsGrant,
  AuthzSubjectsPermissions,
  AuthzSubjectsRevoke,
  AuthzSubjectsRoles,
} from './subjects.js';
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
  AuthzRolesList,
  AuthzRolesGrant,
  AuthzRolesRevoke,
  AuthzPermissionsList,
  AuthzAssignmentsList,
  AuthzAssignmentsAdd,
  AuthzAssignmentsRemove,
  AuthzSubjectsGrant,
  AuthzSubjectsRevoke,
  AuthzSubjectsRoles,
  AuthzSubjectsPermissions,
  AuthzSubjectsExplain,
  AuthzSync,
  AuthzDoctor,
  AgoraDoctor,
]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
