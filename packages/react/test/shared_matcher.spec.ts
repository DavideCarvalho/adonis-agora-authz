import { describe, expect, it } from 'vitest';
import { permissionSatisfied, satisfiesShared } from '../src/matcher.js';

const GRANTS = [
  ['*'],
  ['posts.*'],
  ['posts.*.draft'],
  ['post*'],
  ['posts.**'],
  ['posts'],
  [''],
  ['.'],
  ['posts.edit', 'comments.*'],
  [],
];
const CHECKS = [
  'posts',
  'posts.edit',
  'posts.edit.draft',
  'post',
  'posts.**',
  '*',
  '',
  '.',
  'comments.delete',
];

describe('satisfiesShared', () => {
  it('agrees with permissionSatisfied on the edge-case table', () => {
    for (const granted of GRANTS) {
      for (const check of CHECKS) {
        expect(satisfiesShared(granted, check), `${JSON.stringify(granted)} ⊢ ${check}`).toBe(
          permissionSatisfied(granted, check),
        );
      }
    }
  });

  it('agrees with permissionSatisfied on random grant sets', () => {
    const segs = ['a', 'b', '*', ''];
    const name = () =>
      Array.from(
        { length: 1 + Math.floor(Math.random() * 3) },
        () => segs[Math.floor(Math.random() * segs.length)],
      ).join('.');
    for (let i = 0; i < 2000; i++) {
      const granted = Array.from({ length: Math.floor(Math.random() * 4) }, name);
      const check = name();
      expect(satisfiesShared(granted, check)).toBe(permissionSatisfied(granted, check));
    }
  });

  it('reuses the compiled set for the same array and recompiles when it grows', () => {
    const granted = ['posts.view'];
    expect(satisfiesShared(granted, 'posts.edit')).toBe(false);
    granted.push('posts.*');
    expect(satisfiesShared(granted, 'posts.edit')).toBe(true);
  });
});
