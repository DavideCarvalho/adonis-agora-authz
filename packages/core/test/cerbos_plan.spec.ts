import { describe, expect, it } from 'vitest';
import { CerbosPlanUnsupportedError, cerbosPlanToScope } from '../src/cerbos/plan.js';
import { scopeAll, scopeNone } from '../src/scope.js';

const v = (name: string) => ({ name });
const val = (value: unknown) => ({ value });
const x = (operator: string, ...operands: object[]) => ({ operator, operands }) as never;
const cond = (condition: unknown) => ({ kind: 'KIND_CONDITIONAL', condition }) as never;
const attr = (a: string) => v(`request.resource.attr.${a}`);

describe('cerbosPlanToScope', () => {
  it('maps the unconditional kinds', () => {
    expect(cerbosPlanToScope({ kind: 'KIND_ALWAYS_ALLOWED' })).toBe(scopeAll);
    expect(cerbosPlanToScope({ kind: 'KIND_ALWAYS_DENIED' })).toBe(scopeNone);
  });

  it('maps comparisons against resource attributes (and the resource id)', () => {
    expect(cerbosPlanToScope(cond(x('eq', attr('ownerId'), val('u1'))))).toEqual({
      kind: 'condition',
      field: 'ownerId',
      op: 'eq',
      value: 'u1',
    });
    expect(cerbosPlanToScope(cond(x('in', v('request.resource.id'), val(['a', 'b']))))).toEqual({
      kind: 'condition',
      field: 'id',
      op: 'in',
      value: ['a', 'b'],
    });
    expect(cerbosPlanToScope(cond(x('le', v('R.attr.level'), val(3))))).toMatchObject({
      field: 'level',
      op: 'lte',
    });
  });

  it('flips a comparison written value-first', () => {
    expect(cerbosPlanToScope(cond(x('lt', val(10), attr('age'))))).toMatchObject({
      field: 'age',
      op: 'gt',
      value: 10,
    });
  });

  it('eq/ne null become isNull/isNotNull', () => {
    expect(cerbosPlanToScope(cond(x('eq', attr('deletedAt'), val(null))))).toEqual({
      kind: 'condition',
      field: 'deletedAt',
      op: 'isNull',
    });
    expect(cerbosPlanToScope(cond(x('ne', attr('deletedAt'), val(null))))).toMatchObject({
      op: 'isNotNull',
    });
  });

  it('maps and/or and pushes not down with De Morgan', () => {
    const plan = cond(
      x('not', x('and', x('eq', attr('status'), val('draft')), x('in', attr('team'), val(['a'])))),
    );
    expect(cerbosPlanToScope(plan)).toEqual({
      kind: 'or',
      nodes: [
        { kind: 'condition', field: 'status', op: 'ne', value: 'draft' },
        { kind: 'condition', field: 'team', op: 'nin', value: ['a'] },
      ],
    });
    expect(cerbosPlanToScope(cond(x('not', x('not', x('gt', attr('n'), val(1))))))).toMatchObject({
      op: 'gt',
    });
    expect(cerbosPlanToScope(cond(x('not', x('ge', attr('n'), val(1)))))).toMatchObject({
      op: 'lt',
    });
  });

  it('a bare boolean attribute and boolean constants', () => {
    expect(cerbosPlanToScope(cond(attr('public')))).toMatchObject({ op: 'eq', value: true });
    expect(cerbosPlanToScope(cond(x('not', attr('public'))))).toMatchObject({ value: false });
    expect(cerbosPlanToScope(cond(x('or', val(false), attr('p'))))).toEqual({
      kind: 'or',
      nodes: [
        { kind: 'or', nodes: [] },
        { kind: 'condition', field: 'p', op: 'eq', value: true },
      ],
    });
  });

  it('applies the field mapper and rejects unmapped attributes', () => {
    const field = (a: string) => ({ ownerId: 'owner_id' })[a];
    expect(cerbosPlanToScope(cond(x('eq', attr('ownerId'), val(1))), field)).toMatchObject({
      field: 'owner_id',
    });
    expect(() => cerbosPlanToScope(cond(x('eq', attr('secret'), val(1))), field)).toThrow(
      CerbosPlanUnsupportedError,
    );
  });

  it('rejects nested attributes by default (a dotted field means table.column here)', () => {
    expect(() => cerbosPlanToScope(cond(x('eq', attr('owner.id'), val('u1'))))).toThrow(
      CerbosPlanUnsupportedError,
    );
    // …but a mapper may map them — including onto a qualified `table.column`.
    const field = (a: string) => ({ 'owner.id': 'posts.owner_id' })[a];
    expect(cerbosPlanToScope(cond(x('eq', attr('owner.id'), val('u1'))), field)).toEqual({
      kind: 'condition',
      field: 'posts.owner_id',
      op: 'eq',
      value: 'u1',
    });
  });

  it('rejects a mapped column that is not a safe identifier (fail closed, no injection)', () => {
    const field = () => 'owner_id; DROP TABLE posts';
    expect(() => cerbosPlanToScope(cond(x('eq', attr('owner'), val('u1'))), field)).toThrow(
      CerbosPlanUnsupportedError,
    );
  });

  it('rejects what the scope AST cannot express', () => {
    const unsupported = [
      x('add', attr('a'), val(1)),
      x('in', val('x'), attr('tags')), // collection membership on an attribute
      x('eq', v('request.principal.attr.dept'), val('x')),
      x('eq', attr('a'), attr('b')),
      x('in', attr('a'), val('scalar')),
      x('exists', attr('items'), x('lambda', v('i'))),
    ];
    for (const condition of unsupported) {
      expect(() => cerbosPlanToScope(cond(condition))).toThrow(CerbosPlanUnsupportedError);
    }
    expect(() => cerbosPlanToScope({ kind: 'KIND_WHATEVER' })).toThrow(CerbosPlanUnsupportedError);
  });
});
