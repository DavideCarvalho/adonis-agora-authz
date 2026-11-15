import { createHmac } from 'node:crypto';
import {
  emitAuthkitEvent,
  memoryReplayStore,
  verifyAuthkitWebhook,
} from '@adonis-agora/authkit-client';
import { unsubscribeAll } from '@adonis-agora/diagnostics';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiagnosticEvent } from './agora/diagnostics.js';
import { defineAuthzProvisioning } from './provisioning.js';
import { MemoryPermissionStore } from './stores/memory.js';

/*
 * The real `@adonis-agora/diagnostics` bus (no mock): it hands subscribers an envelope,
 * `{ v, ts, lib, event, traceId, payload }`, so this is what proves actions get the authkit
 * event itself. Two producers, one contract:
 * - in process, authkit-server publishes its redacted audit event through the emit slot;
 * - on another server, authkit-client's webhook receiver re-emits the signed delivery.
 */

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
type EmitFn = (lib: string, event: string, payload: unknown) => void;

/** What authkit-server does in process (`emitDiagnostic(type, redactAuditEventForDiagnostics(e))`). */
function emitInProcess(event: {
  type: string;
  accountId: string | null;
  actorId: string | null;
  clientId: string | null;
  orgId: string | null;
}) {
  const emit = (globalThis as Record<symbol, unknown>)[EMIT_SLOT] as EmitFn;
  emit('authkit', event.type, {
    type: event.type,
    accountId: event.accountId,
    actorId: event.actorId,
    clientId: event.clientId,
    orgId: event.orgId,
  });
}

const SECRET = 'whsec_test';

/** What reaches another server: authkit-server's signed webhook, through authkit-client. */
async function emitThroughWebhook(fields: Record<string, unknown>) {
  const body = JSON.stringify({
    id: `evt_${Math.random().toString(36).slice(2)}`,
    ts: new Date().toISOString(),
    email: 'owner@example.com',
    ip: '203.0.113.7',
    metadata: { name: 'Acme' },
    ...fields,
  });
  const signature = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
  const verdict = await verifyAuthkitWebhook(
    { body, signature },
    { secret: SECRET, replayStore: memoryReplayStore() },
  );
  if (!verdict.ok) throw new Error(`webhook refused: ${verdict.reason}`);
  emitAuthkitEvent(verdict.event);
}

/** Diagnostics invokes async handlers without awaiting them. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => unsubscribeAll());

describe('provisioning on the real diagnostics bus', () => {
  async function provision() {
    const store = new MemoryPermissionStore();
    const seen: DiagnosticEvent[] = [];
    const provisioning = await defineAuthzProvisioning({
      store,
      on: {
        'organization.created': async (ev, s) => {
          seen.push(ev);
          if (!ev.accountId || !ev.orgId) return;
          await s.assignRole({ type: 'user', id: ev.accountId }, 'org:owner', {
            tenantId: ev.orgId,
          });
        },
      },
    });
    const roles = (accountId: string, tenantId: string) =>
      store.getRolesForSubject({ type: 'user', id: accountId }, { tenantId });
    return { provisioning, roles, seen };
  }

  const created = {
    type: 'organization.created',
    accountId: 'owner-1',
    actorId: 'admin-9',
    clientId: 'app-1',
    orgId: 'acme',
  };

  it('in process: the action gets the authkit event, not the bus envelope', async () => {
    const { provisioning, roles, seen } = await provision();
    emitInProcess(created);
    await settle();

    expect(seen).toEqual([created]);
    expect(await roles('owner-1', 'acme')).toContain('org:owner');
    provisioning.stop();
  });

  it('through the authkit-client webhook receiver: exactly the same event and roles', async () => {
    const { provisioning, roles, seen } = await provision();
    await emitThroughWebhook(created);
    await settle();

    // Same fields as in process; the webhook's email, ip and metadata never reach the bus.
    expect(seen).toEqual([created]);
    expect(await roles('owner-1', 'acme')).toContain('org:owner');
    provisioning.stop();
  });

  it('ignores event types it does not map', async () => {
    const { provisioning, seen } = await provision();
    await emitThroughWebhook({ ...created, type: 'member.added' });
    await settle();

    expect(seen).toEqual([]);
    provisioning.stop();
  });
});
