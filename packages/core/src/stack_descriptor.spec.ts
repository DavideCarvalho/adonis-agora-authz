import { afterEach, describe, expect, it, vi } from 'vitest';
import { CerbosDecisionProvider } from './cerbos/decision_provider.js';
import { defineConfig, stores } from './define_config.js';
import { STACK_DESCRIPTOR } from './stack.js';

const appConfig = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@adonisjs/core/services/app', () => ({
  default: { config: { get: (key: string) => appConfig.current[key] } },
}));

const uses = (value: object) => (value as Record<symbol, unknown>)[STACK_DESCRIPTOR];

afterEach(() => {
  appConfig.current = {};
});

describe('stack descriptors', () => {
  it('describes the active Lucid store on the defineConfig result, not enumerable', () => {
    appConfig.current = {
      database: {
        connection: 'pg',
        connections: { pg: { client: 'pg' }, my: { client: 'mysql2' } },
      },
    };
    expect(STACK_DESCRIPTOR).toBe(Symbol.for('@adonis-agora/stack'));
    const config = defineConfig({
      default: 'lucid',
      stores: { memory: stores.memory(), lucid: stores.lucid() },
    });
    expect(uses(config)).toEqual([{ tech: 'postgres', connection: 'pg', purpose: 'permissions' }]);
    expect(Object.keys(config)).toEqual(['default', 'stores']);
    expect(
      uses(
        defineConfig({ stores: { lucid: stores.lucid({ connection: 'my', schema: 'authz' }) } }),
      ),
    ).toEqual([{ tech: 'mysql', connection: 'my', purpose: 'permissions' }]);
  });

  it('describes nothing when the active store is memory', () => {
    const config = defineConfig({
      default: 'memory',
      stores: { memory: stores.memory(), lucid: stores.lucid() },
    });
    expect(uses(config)).toEqual([]);
    expect(uses(defineConfig({}))).toEqual([]);
  });

  it('describes the Cerbos decision provider', () => {
    const provider = new CerbosDecisionProvider({
      client: {} as never,
      principal: () => undefined,
      resource: () => undefined,
    } as never);
    expect(uses(provider)).toEqual([{ tech: 'cerbos', label: 'cerbos', purpose: 'decisions' }]);
  });
});
