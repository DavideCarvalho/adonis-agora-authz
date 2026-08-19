import { describe, expect, it, vi } from 'vitest';
import type { DiagnosticEvent, OnDiagnostic } from './agora/diagnostics.js';
import { defineAuthzProvisioning } from './provisioning.js';
import { MemoryPermissionStore } from './stores/memory.js';

// Mock the optional diagnostics peer so the structural import resolves in tests.
vi.mock('@adonis-agora/diagnostics', () => {
  type Handler = (e: DiagnosticEvent) => void | Promise<void>;
  const handlers = new Map<string, Handler>();
  const onDiagnostic: OnDiagnostic = (lib, event, handler) => {
    const key = `${lib}:${event}`;
    handlers.set(key, handler);
    return () => handlers.delete(key);
  };
  // Test seam to drive events.
  (onDiagnostic as unknown as { __emit: (k: string, e: DiagnosticEvent) => unknown }).__emit = (
    key: string,
    event: DiagnosticEvent,
  ) => handlers.get(key)?.(event);
  return { onDiagnostic };
});

async function emitter() {
  const mod = (await import('@adonis-agora/diagnostics')) as unknown as {
    onDiagnostic: { __emit: (k: string, e: DiagnosticEvent) => Promise<unknown> };
  };
  return mod.onDiagnostic.__emit;
}

describe('feature A — event-driven provisioning', () => {
  // NOTE: this exercises the `metadata` shape, which only reaches a subscriber
  // when the HOST feeds the bus (or wires authkit's un-redacted `events.onEvent`).
  // Events coming through authkit's own diagnostics bridge are redacted — see the
  // 'contrato real do payload do authkit' suite below for that path.
  it('runs the mapped action when an event carrying metadata fires', async () => {
    const store = new MemoryPermissionStore();
    const emit = await emitter();

    const provisioning = await defineAuthzProvisioning({
      store,
      on: {
        'organization.created': async (ev, s) => {
          const orgId = ev.metadata?.orgId as string;
          await s.assignRole({ type: 'user', id: '1' }, 'org:owner', { tenantId: orgId });
        },
      },
    });

    await emit('authkit:organization.created', { metadata: { orgId: 'acme' } });

    expect(await store.getRolesForUser({ type: 'user', id: '1' }, { tenantId: 'acme' })).toContain(
      'org:owner',
    );
    provisioning.stop();
  });

  it('is best-effort: a throwing action never propagates and calls onError', async () => {
    const store = new MemoryPermissionStore();
    const emit = await emitter();
    const errors: unknown[] = [];

    const provisioning = await defineAuthzProvisioning({
      store,
      onError: (e) => errors.push(e),
      on: {
        'member.added': () => {
          throw new Error('boom');
        },
      },
    });

    await expect(emit('authkit:member.added', { metadata: {} })).resolves.not.toThrow();
    expect(errors).toHaveLength(1);
    provisioning.stop();
  });

  it('stop() unsubscribes handlers', async () => {
    const store = new MemoryPermissionStore();
    const emit = await emitter();
    let calls = 0;

    const provisioning = await defineAuthzProvisioning({
      store,
      on: { 'account.created': () => void calls++ },
    });
    provisioning.stop();
    await emit('authkit:account.created', {});
    expect(calls).toBe(0);
  });
});

describe('provisioning — contrato real do payload do authkit', () => {
  it('lê o orgId do topo do evento (o authkit redige `metadata` na ponte de diagnostics)', async () => {
    const store = new MemoryPermissionStore();
    const emit = await emitter();

    const provisioning = await defineAuthzProvisioning({
      store,
      on: {
        'organization.created': async (ev, s) => {
          await s.assignRole({ type: 'user', id: ev.accountId as string }, 'org:owner', {
            tenantId: ev.orgId as string,
          });
        },
      },
    });

    // Este é o payload EXATO que `redactAuditEventForDiagnostics` publica:
    // sem `email`/`ip`/`metadata` (PII), só o tipo e os ids opacos.
    await emit('authkit:organization.created', {
      type: 'organization.created',
      accountId: 'owner-1',
      actorId: null,
      clientId: null,
      orgId: 'acme',
    });

    expect(
      await store.getRolesForUser({ type: 'user', id: 'owner-1' }, { tenantId: 'acme' }),
    ).toContain('org:owner');
    provisioning.stop();
  });
});
