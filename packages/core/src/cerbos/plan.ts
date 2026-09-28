import {
  SAFE_IDENTIFIER,
  type ScopeCondition,
  type ScopeConstraint,
  type ScopeNode,
  type ScopeOperator,
  scopeAll,
  scopeNone,
} from '../scope.js';

/** A Cerbos query-plan operand (structural mirror of `@cerbos/core`'s `PlanExpressionOperand`). */
export type CerbosPlanOperand =
  | { operator: string; operands: CerbosPlanOperand[] }
  | { value: unknown }
  | { name: string };

/** A Cerbos `PlanResources` response (structural: `kind` + optional `condition`). */
export interface CerbosPlanLike {
  kind: string;
  condition?: CerbosPlanOperand;
}

/**
 * Maps a Cerbos resource attribute (the part after `request.resource.attr.`, or `id` for
 * `request.resource.id`) to a scope `field` — a column the Lucid `accessibleBy` adapter puts in
 * the `WHERE` (`owner_id`, or a qualified `posts.owner_id`). Return `undefined` to reject the
 * attribute — the plan is then unsupported (fail closed).
 *
 * The default mapper ({@link defaultCerbosFieldMapper}) keeps a plain attribute name as-is and
 * REJECTS a nested one (`owner.id`): the scope AST reads a dotted field as `table.column`, which
 * is not what a nested Cerbos attribute means. Map nested attributes (and camelCase → snake_case
 * columns) explicitly.
 */
export type CerbosFieldMapper = (attribute: string) => string | undefined;

/** Identity for plain attribute names; `undefined` (reject) for nested `a.b` attributes. */
export const defaultCerbosFieldMapper: CerbosFieldMapper = (attribute) =>
  attribute.includes('.') ? undefined : attribute;

/** Thrown when a Cerbos query plan uses something the scope AST cannot express. */
export class CerbosPlanUnsupportedError extends Error {
  constructor(message: string) {
    super(`Unsupported Cerbos query plan: ${message}`);
    this.name = 'CerbosPlanUnsupportedError';
  }
}

const ALWAYS_ALLOWED = 'KIND_ALWAYS_ALLOWED';
const ALWAYS_DENIED = 'KIND_ALWAYS_DENIED';
const CONDITIONAL = 'KIND_CONDITIONAL';

/** Cerbos comparison operator → scope operator. */
const COMPARISON: Record<string, ScopeOperator> = {
  eq: 'eq',
  ne: 'ne',
  lt: 'lt',
  gt: 'gt',
  le: 'lte',
  ge: 'gte',
  in: 'in',
};

/** Logical negation of a scope operator (used to push `not` down to the leaves). */
const NEGATED: Record<ScopeOperator, ScopeOperator> = {
  eq: 'ne',
  ne: 'eq',
  lt: 'gte',
  gte: 'lt',
  gt: 'lte',
  lte: 'gt',
  in: 'nin',
  nin: 'in',
  isNull: 'isNotNull',
  isNotNull: 'isNull',
};

/** Swap sides of a comparison (`value < attr` ⇔ `attr > value`). */
const FLIPPED: Partial<Record<ScopeOperator, ScopeOperator>> = {
  eq: 'eq',
  ne: 'ne',
  lt: 'gt',
  gt: 'lt',
  lte: 'gte',
  gte: 'lte',
};

const isExpression = (
  o: CerbosPlanOperand,
): o is { operator: string; operands: CerbosPlanOperand[] } =>
  typeof (o as { operator?: unknown }).operator === 'string';
const isVariable = (o: CerbosPlanOperand): o is { name: string } =>
  typeof (o as { name?: unknown }).name === 'string';
const isValue = (o: CerbosPlanOperand): o is { value: unknown } => 'value' in (o as object);

const RESOURCE_ATTR_PREFIXES = ['request.resource.attr.', 'R.attr.'];
const RESOURCE_ID = new Set(['request.resource.id', 'R.id']);

function attributeOf(name: string): string | undefined {
  if (RESOURCE_ID.has(name)) return 'id';
  for (const prefix of RESOURCE_ATTR_PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return undefined;
}

const always = (allowed: boolean): ScopeNode => ({ kind: allowed ? 'and' : 'or', nodes: [] });

/**
 * Translate a Cerbos `PlanResources` result into the ORM-neutral {@link ScopeConstraint} that
 * `authz.scope()` returns (and `accessibleBy` compiles to a WHERE):
 *
 * - `KIND_ALWAYS_ALLOWED` → `allow-all`, `KIND_ALWAYS_DENIED` → `deny-all`;
 * - `KIND_CONDITIONAL` → the condition tree: `and`/`or` → groups, `not` pushed down to the leaves
 *   (De Morgan; `eq`↔`ne`, `lt`↔`gte`, `in`↔`nin`, …), comparisons `eq ne lt gt le ge in` against
 *   a resource attribute → leaf conditions (`eq null` → `isNull`). Operands may appear in either
 *   order (`value < attr` is flipped).
 *
 * Anything else — arithmetic, `exists`/`all`/lambdas, collection membership on an attribute
 * (`"x" in R.attr.tags`), principal variables, unmapped attributes — throws
 * {@link CerbosPlanUnsupportedError}; callers should fail closed. So does a mapped field that is
 * not a safe identifier (see `SAFE_IDENTIFIER`).
 */
export function cerbosPlanToScope(
  plan: CerbosPlanLike,
  field: CerbosFieldMapper = defaultCerbosFieldMapper,
): ScopeConstraint {
  if (plan.kind === ALWAYS_ALLOWED) return scopeAll;
  if (plan.kind === ALWAYS_DENIED) return scopeNone;
  if (plan.kind !== CONDITIONAL || !plan.condition) {
    throw new CerbosPlanUnsupportedError(`unknown plan kind ${JSON.stringify(plan.kind)}`);
  }
  return toNode(plan.condition, false, field);
}

function toNode(operand: CerbosPlanOperand, negate: boolean, field: CerbosFieldMapper): ScopeNode {
  if (isValue(operand)) {
    if (typeof operand.value !== 'boolean') {
      throw new CerbosPlanUnsupportedError('a non-boolean constant used as a condition');
    }
    return always(operand.value !== negate);
  }
  if (isVariable(operand)) {
    // A bare boolean attribute (`R.attr.public`).
    return leaf(operand.name, 'eq', !negate, field);
  }
  if (!isExpression(operand)) throw new CerbosPlanUnsupportedError('malformed operand');

  const { operator, operands } = operand;
  if (operator === 'not') {
    const [inner] = operands;
    if (operands.length !== 1 || !inner) throw new CerbosPlanUnsupportedError('`not` arity');
    return toNode(inner, !negate, field);
  }
  if (operator === 'and' || operator === 'or') {
    // De Morgan: ¬(a ∧ b) = ¬a ∨ ¬b.
    const isAnd = (operator === 'and') !== negate;
    return {
      kind: isAnd ? 'and' : 'or',
      nodes: operands.map((child) => toNode(child, negate, field)),
    };
  }
  const op = COMPARISON[operator];
  if (!op) throw new CerbosPlanUnsupportedError(`operator "${operator}"`);
  const [left, right] = operands;
  if (operands.length !== 2 || !left || !right) {
    throw new CerbosPlanUnsupportedError(`\`${operator}\` arity`);
  }

  let variable: { name: string };
  let value: unknown;
  let effective: ScopeOperator = op;
  if (isVariable(left) && isValue(right)) {
    variable = left;
    value = right.value;
  } else if (isValue(left) && isVariable(right)) {
    const flipped = FLIPPED[op];
    if (!flipped) {
      throw new CerbosPlanUnsupportedError(
        `"${operator}" with the attribute on the right (collection membership)`,
      );
    }
    variable = right;
    value = left.value;
    effective = flipped;
  } else {
    throw new CerbosPlanUnsupportedError(`"${operator}" must compare one attribute with one value`);
  }

  if (value === null && (effective === 'eq' || effective === 'ne')) {
    effective = effective === 'eq' ? 'isNull' : 'isNotNull';
  }
  if (effective === 'in' && !Array.isArray(value)) {
    throw new CerbosPlanUnsupportedError('`in` needs a list value');
  }
  return leaf(variable.name, negate ? NEGATED[effective] : effective, value, field);
}

function leaf(
  variable: string,
  op: ScopeOperator,
  value: unknown,
  field: CerbosFieldMapper,
): ScopeCondition {
  const attribute = attributeOf(variable);
  if (attribute === undefined) {
    throw new CerbosPlanUnsupportedError(`variable "${variable}" is not a resource attribute`);
  }
  const mapped = field(attribute);
  if (mapped === undefined) {
    throw new CerbosPlanUnsupportedError(`resource attribute "${attribute}" is not mapped`);
  }
  if (!SAFE_IDENTIFIER.test(mapped)) {
    throw new CerbosPlanUnsupportedError(
      `resource attribute "${attribute}" maps to an unsafe column ${JSON.stringify(mapped)}`,
    );
  }
  return op === 'isNull' || op === 'isNotNull'
    ? { kind: 'condition', field: mapped, op }
    : { kind: 'condition', field: mapped, op, value };
}
