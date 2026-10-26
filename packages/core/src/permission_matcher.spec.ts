import { describe, expect, it } from 'vitest';
import {
  CompiledPermissions,
  permissionMatches,
  permissionSatisfied,
} from './permission_matcher.js';

describe('permissionMatches', () => {
  it('matches exact strings', () => {
    expect(permissionMatches('posts.edit', 'posts.edit')).toBe(true);
    expect(permissionMatches('posts.edit', 'posts.delete')).toBe(false);
  });

  it('global wildcard matches anything', () => {
    expect(permissionMatches('*', 'posts.edit')).toBe(true);
    expect(permissionMatches('*', 'anything')).toBe(true);
    expect(permissionMatches('*', '*')).toBe(true);
  });

  it('trailing wildcard matches one-or-more remaining segments', () => {
    expect(permissionMatches('posts.*', 'posts.edit')).toBe(true);
    expect(permissionMatches('posts.*', 'posts.edit.draft')).toBe(true);
  });

  it('trailing wildcard does NOT match the bare prefix (zero remaining)', () => {
    expect(permissionMatches('posts.*', 'posts')).toBe(false);
  });

  it('wildcard only matches within the same namespace', () => {
    expect(permissionMatches('posts.*', 'comments.edit')).toBe(false);
  });

  it('interior wildcard consumes exactly one segment', () => {
    expect(permissionMatches('posts.*.draft', 'posts.edit.draft')).toBe(true);
    expect(permissionMatches('posts.*.draft', 'posts.draft')).toBe(false);
    expect(permissionMatches('posts.*.draft', 'posts.edit.published')).toBe(false);
  });

  it('a longer required ability does not match a shorter literal granted', () => {
    expect(permissionMatches('posts', 'posts.edit')).toBe(false);
    expect(permissionMatches('posts.edit', 'posts')).toBe(false);
  });

  it('treats the required side literally (a required * is not a pattern)', () => {
    expect(permissionMatches('posts.edit', 'posts.*')).toBe(false);
    expect(permissionMatches('posts.*', 'posts.*')).toBe(true); // identical strings
  });
});

describe('permissionSatisfied', () => {
  it('is true when any granted pattern matches', () => {
    expect(permissionSatisfied(['comments.view', 'posts.*'], 'posts.edit')).toBe(true);
  });

  it('is false when none match', () => {
    expect(permissionSatisfied(['comments.view', 'posts.view'], 'posts.edit')).toBe(false);
  });

  it('is false for an empty grant set', () => {
    expect(permissionSatisfied([], 'posts.edit')).toBe(false);
  });
});

describe('CompiledPermissions (precompiled granted set)', () => {
  const edgeGrants = [
    '*',
    'posts.*',
    'posts.*.draft',
    '*.update',
    'posts.update',
    'posts',
    'post*',
    'posts.**',
    '',
    '.',
    'posts.',
    '.*',
    '*.*',
    'a.*.*',
  ];
  const edgeChecks = [
    'posts',
    'posts.update',
    'posts.update.draft',
    'posts.edit.draft',
    'comments.update',
    'post*',
    'posts.*',
    'posts.**',
    '*',
    '',
    '.',
    'posts.',
    'a',
    'a.b',
    'a.b.c',
    'a.b.c.d',
  ];

  it('agrees with permissionSatisfied on every single-grant edge case', () => {
    for (const g of edgeGrants) {
      const compiled = new CompiledPermissions([g]);
      for (const r of edgeChecks) {
        expect(compiled.satisfies(r), `${JSON.stringify(g)} vs ${JSON.stringify(r)}`).toBe(
          permissionSatisfied([g], r),
        );
      }
    }
  });

  it('agrees with permissionSatisfied on random grant sets', () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const segments = ['a', 'b', 'c', '*', '', 'a*'];
    const name = () =>
      Array.from({ length: 1 + rand(4) }, () => segments[rand(segments.length)]).join('.');
    for (let round = 0; round < 500; round++) {
      const granted = Array.from({ length: rand(6) }, name);
      const compiled = new CompiledPermissions(granted);
      for (let i = 0; i < 20; i++) {
        const required = name();
        expect(compiled.satisfies(required), `${JSON.stringify(granted)} vs ${required}`).toBe(
          permissionSatisfied(granted, required),
        );
      }
    }
  });

  it('exposes the deduped granted set', () => {
    expect([...new CompiledPermissions(['a', 'b.*', 'a']).granted]).toEqual(['a', 'b.*']);
  });
});
