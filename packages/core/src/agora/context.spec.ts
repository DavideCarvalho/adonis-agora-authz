import { afterEach, describe, expect, it } from 'vitest';
import {
  AGORA_CONTEXT_ACCESSOR,
  globalRolesFromContext,
  readContextValue,
  tenantFromContext,
  userRefFromContext,
} from './context.js';

type GlobalSlots = Record<symbol, unknown>;

function setAccessor(value: unknown): void {
  (globalThis as GlobalSlots)[AGORA_CONTEXT_ACCESSOR] = value;
}

afterEach(() => {
  delete (globalThis as GlobalSlots)[AGORA_CONTEXT_ACCESSOR];
});

describe('agora context bridge', () => {
  it('returns undefined when no accessor slot is present', () => {
    expect(tenantFromContext()).toBeUndefined();
    expect(userRefFromContext()).toBeUndefined();
    expect(globalRolesFromContext()).toEqual([]);
    expect(readContextValue('globalRoles')).toBeUndefined();
  });

  // The real @adonis-agora/context accessor (packages/core/src/accessor.ts) publishes
  // `tenantId`/`userRef` as METHODS, not plain properties. Earlier versions of this test
  // faked `tenantId` as a string value, a contract the context lib never shipped — which
  // is exactly why the bug (authz reading the function reference itself, truthy but
  // wrong, instead of calling it) went unnoticed.
  it('reads tenantId structurally from the accessor by calling it', () => {
    setAccessor({ tenantId: () => 'acme' });
    expect(tenantFromContext()).toBe('acme');
  });

  it('reads userRef structurally from the accessor by calling it', () => {
    setAccessor({ userRef: () => ({ type: 'user', id: '42' }) });
    expect(userRefFromContext()).toEqual({ type: 'user', id: '42' });
  });

  it('treats empty-string tenantId as no tenant', () => {
    setAccessor({ tenantId: () => '' });
    expect(tenantFromContext()).toBeUndefined();
  });

  it('treats a tenantId field that is not a function as absent', () => {
    // Guards against regressing to the old plain-property contract: if some caller
    // publishes a non-callable `tenantId`, we must not read it as a value.
    setAccessor({ tenantId: 'acme' as unknown as () => string });
    expect(tenantFromContext()).toBeUndefined();
  });

  it('treats a userRef field that is not a function as absent', () => {
    setAccessor({ userRef: { type: 'user', id: '1' } as unknown as () => undefined });
    expect(userRefFromContext()).toBeUndefined();
  });

  it('tolerates a throwing tenantId() accessor', () => {
    setAccessor({
      tenantId: () => {
        throw new Error('boom');
      },
    });
    expect(tenantFromContext()).toBeUndefined();
  });

  it('tolerates a throwing userRef() accessor', () => {
    setAccessor({
      userRef: () => {
        throw new Error('boom');
      },
    });
    expect(userRefFromContext()).toBeUndefined();
  });

  it('returns undefined when the accessor has no tenantId/userRef field at all', () => {
    setAccessor({ get: () => ({}) });
    expect(tenantFromContext()).toBeUndefined();
    expect(userRefFromContext()).toBeUndefined();
  });

  // The real @adonis-agora/context accessor implements get() → the whole store, and
  // NOTHING else. Earlier versions of these tests faked `get(key) => store[key]`,
  // a contract the context lib never shipped — which is exactly why the bug (authz
  // getting the whole store back and its Array.isArray failing) went unnoticed.
  it('reads global roles from the real accessor shape (get() → whole store)', () => {
    setAccessor({ get: () => ({ traceId: 't1', globalRoles: ['super-admin', 'auditor'] }) });
    expect(globalRolesFromContext()).toEqual(['super-admin', 'auditor']);
  });

  it('tolerates a throwing get() accessor', () => {
    setAccessor({
      get: () => {
        throw new Error('boom');
      },
    });
    expect(globalRolesFromContext()).toEqual([]);
  });

  it('filters non-string global roles', () => {
    setAccessor({ get: () => ({ globalRoles: ['admin', 42, null] }) });
    expect(globalRolesFromContext()).toEqual(['admin']);
  });

  it('returns [] when the store has no globalRoles key', () => {
    setAccessor({ get: () => ({ traceId: 't1' }) });
    expect(globalRolesFromContext()).toEqual([]);
  });
});
