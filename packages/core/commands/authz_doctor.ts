import AgoraDoctor from './agora_doctor.js';

/** `node ace authz:doctor`: `agora:doctor` for `@adonis-agora/authz` only. */
export default class AuthzDoctor extends AgoraDoctor {
  static override commandName = 'authz:doctor';
  static override description = 'Check the @adonis-agora/authz configuration';
  protected override presetLib: string | undefined = 'authz';
}
