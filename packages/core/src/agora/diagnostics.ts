/**
 * Structural bridge to the Agora diagnostics bus.
 *
 * `@adonis-agora/diagnostics` is an OPTIONAL peer. We resolve its `onDiagnostic`
 * subscriber via the package when installed, and otherwise degrade to a no-op.
 * authz never hard-depends on it.
 */

/** The symbol slot the diagnostics library writes its `emit` function into. */
export const AGORA_DIAGNOSTICS_EMIT = Symbol.for('@agora/diagnostics:emit');

/**
 * A diagnostics event as published by authkit on channel `agora:authkit:<type>`.
 *
 * IMPORTANT — this mirrors what authkit ACTUALLY puts on the bus, which is a
 * REDACTED projection of its audit event (`redactAuditEventForDiagnostics`):
 * `email`, `ip` and the free-form `metadata` are stripped so no PII ever reaches
 * a subscriber's store. What survives is the event type plus the opaque internal
 * ids below — which is exactly what provisioning needs.
 *
 * So: read `orgId`/`accountId` from the TOP LEVEL. `metadata` is kept in the type
 * only because a host may wire `defineAuthzProvisioning` to a bus it feeds itself
 * (or to authkit's un-redacted `events.onEvent`), where it is present.
 */
export interface DiagnosticEvent {
  /** Event type, e.g. `account.created`, `organization.created`, `member.added`. */
  type?: string;
  /** Subject of the event — the account it happened to. */
  accountId?: string | null;
  /** Who performed it, when different from the subject (impersonation/admin). */
  actorId?: string | null;
  /** OAuth client involved, when any. */
  clientId?: string | null;
  /** The organization (tenant) the event belongs to — the key to scope roles by. */
  orgId?: string | null;
  /**
   * Free-form payload. Absent on events that came through authkit's diagnostics
   * bridge (redacted); present when the host feeds the bus itself.
   */
  metadata?: Record<string, unknown>;
}

/** Subscriber signature exposed by `@adonis-agora/diagnostics`. */
export type OnDiagnostic = (
  lib: string,
  event: string | undefined,
  handler: (event: DiagnosticEvent) => void | Promise<void>,
) => undefined | (() => void);

/**
 * Resolve `onDiagnostic` from `@adonis-agora/diagnostics` (optional peer),
 * structurally. Returns `undefined` when the package is not installed.
 */
export async function resolveOnDiagnostic(): Promise<OnDiagnostic | undefined> {
  try {
    // Computed specifier so TypeScript does not require the optional peer to be
    // installed to typecheck. Resolved at runtime only when present.
    const specifier = '@adonis-agora/diagnostics';
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      onDiagnostic?: OnDiagnostic;
    };
    return typeof mod.onDiagnostic === 'function' ? mod.onDiagnostic : undefined;
  } catch {
    return undefined;
  }
}
