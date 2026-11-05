import type { IR } from '../../../ir/types';
import { refToName } from '../../../utils/ref';

/**
 * Supported types for discriminator properties.
 */
export type DiscriminatorPropertyType = 'boolean' | 'integer' | 'number' | 'string';

/**
 * Converts a string discriminator mapping value to the appropriate type based on
 * the actual property type in the schema.
 *
 * OpenAPI discriminator mappings always use string keys, but the actual discriminator
 * property may be a boolean, number, or integer. This function converts the string
 * key to the correct runtime value and IR type.
 */
export function convertDiscriminatorValue(
  value: string,
  propertyType: DiscriminatorPropertyType,
): { const: IR.SchemaObject['const']; type: IR.SchemaObject['type'] } {
  switch (propertyType) {
    case 'boolean': {
      const lowerValue = value.toLowerCase();
      if (lowerValue !== 'true' && lowerValue !== 'false') {
        console.warn(
          '🚨',
          `non-boolean discriminator mapping value "${value}" for boolean property, falling back to string`,
        );
        return {
          const: value,
          type: 'string',
        };
      }
      return {
        const: lowerValue === 'true',
        type: 'boolean',
      };
    }
    case 'integer': {
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed)) {
        console.warn(
          '🚨',
          `non-numeric discriminator mapping value "${value}" for integer property, falling back to string`,
        );
        return {
          const: value,
          type: 'string',
        };
      }
      return {
        const: parsed,
        type: 'integer',
      };
    }
    case 'number': {
      const parsed = parseFloat(value);
      if (Number.isNaN(parsed)) {
        console.warn(
          '🚨',
          `non-numeric discriminator mapping value "${value}" for number property, falling back to string`,
        );
        return {
          const: value,
          type: 'string',
        };
      }
      return {
        const: parsed,
        type: 'number',
      };
    }
    default:
      return {
        const: value,
        type: 'string',
      };
  }
}

export function discriminatorValues(
  $ref: string,
  mapping?: Record<string, string>,
  shouldUseRefAsValue?: () => boolean,
): ReadonlyArray<string> {
  const values: Array<string> = [];

  for (const name in mapping) {
    if (mapping[name] === $ref) {
      values.push(name);
    }
  }

  if (!values.length && (!shouldUseRefAsValue || shouldUseRefAsValue())) {
    return [refToName($ref)];
  }

  return values;
}

/**
 * A branch's own constraint on the discriminator property.
 *
 * `absent` means this schema does not mention the property. `open` means the
 * property is present but accepts more than a finite set of values. `values`
 * is an enum or const, which is what a payload actually sends.
 */
type DiscriminatorConstraint =
  | { kind: 'absent' }
  | { kind: 'open' }
  | { kind: 'values'; values: Array<unknown> };

function sameValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}

function uniqueValues(values: ReadonlyArray<unknown>): Array<unknown> {
  const result: Array<unknown> = [];
  for (const value of values) {
    if (!result.some((existing) => sameValue(existing, value))) {
      result.push(value);
    }
  }
  return result;
}

function intersectConstraints(
  left: DiscriminatorConstraint,
  right: DiscriminatorConstraint,
): DiscriminatorConstraint {
  if (left.kind === 'absent') return right;
  if (right.kind === 'absent') return left;
  if (left.kind === 'open') return right;
  if (right.kind === 'open') return left;
  return {
    kind: 'values',
    values: left.values.filter((value) => right.values.some((other) => sameValue(value, other))),
  };
}

function unionConstraints(
  left: DiscriminatorConstraint,
  right: DiscriminatorConstraint,
): DiscriminatorConstraint {
  if (left.kind === 'open' || right.kind === 'open') return { kind: 'open' };
  if (left.kind === 'absent') return right;
  if (right.kind === 'absent') return left;
  return {
    kind: 'values',
    values: uniqueValues([...left.values, ...right.values]),
  };
}

/**
 * Mapping keys are strings. Compare them to a branch const by the const's
 * runtime type, so `False` matches `false` and `1` matches `1`.
 */
function mappedMatches(mapped: string, constraint: unknown): boolean {
  if (sameValue(mapped, constraint)) return true;
  if (typeof constraint === 'boolean') {
    return mapped.toLowerCase() === String(constraint);
  }
  if (typeof constraint === 'number') {
    if (Number.isInteger(constraint)) {
      return /^-?\d+$/.test(mapped) && Number.parseInt(mapped, 10) === constraint;
    }
    const parsed = Number(mapped);
    return !Number.isNaN(parsed) && parsed === constraint;
  }
  return false;
}

function discriminatorValueKey(value: unknown): string {
  return `${typeof value}:${String(value)}`;
}

function finiteValues(
  schema: IR.SchemaObject,
  resolveIrRef: (ref: string) => IR.SchemaObject | undefined,
  seen: Set<string>,
): DiscriminatorConstraint {
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return { kind: 'open' };
    let resolved: IR.SchemaObject | undefined;
    try {
      resolved = resolveIrRef(schema.$ref);
    } catch {
      return { kind: 'open' };
    }
    if (!resolved) return { kind: 'open' };
    seen.add(schema.$ref);
    const constraint = finiteValues(resolved, resolveIrRef, seen);
    seen.delete(schema.$ref);
    return constraint;
  }

  if (schema.const !== undefined) {
    return { kind: 'values', values: [schema.const] };
  }

  if (schema.type === 'enum' && schema.items) {
    const values: Array<unknown> = [];
    for (const item of schema.items) {
      if (item.const === undefined) return { kind: 'open' };
      values.push(item.const);
    }
    return values.length ? { kind: 'values', values } : { kind: 'open' };
  }

  if (
    schema.items &&
    schema.type !== 'array' &&
    schema.type !== 'tuple' &&
    (schema.logicalOperator === 'and' ||
      schema.logicalOperator === 'or' ||
      schema.type === undefined)
  ) {
    let combined: DiscriminatorConstraint | undefined;
    const combine = schema.logicalOperator === 'and' ? intersectConstraints : unionConstraints;
    for (const item of schema.items) {
      const next = finiteValues(item, resolveIrRef, seen);
      combined = combined ? combine(combined, next) : next;
    }
    return combined ?? { kind: 'open' };
  }

  return { kind: 'open' };
}

/**
 * Collects enum and const values the branch itself assigns to `propertyName`,
 * including through `$ref` and `allOf`. An unconstrained string stays `open`:
 * the implicit schema name is still a valid narrowing.
 */
function propertyConstraint(
  schema: IR.SchemaObject,
  propertyName: string,
  resolveIrRef: (ref: string) => IR.SchemaObject | undefined,
  seen: Set<string>,
): DiscriminatorConstraint {
  if (schema.$ref) {
    let fromRef: DiscriminatorConstraint = { kind: 'absent' };
    if (!schema.omit?.includes(propertyName) && !seen.has(schema.$ref)) {
      let resolved: IR.SchemaObject | undefined;
      try {
        resolved = resolveIrRef(schema.$ref);
      } catch {
        resolved = undefined;
      }
      if (resolved) {
        seen.add(schema.$ref);
        fromRef = propertyConstraint(resolved, propertyName, resolveIrRef, seen);
        seen.delete(schema.$ref);
      }
    }
    if (!schema.properties && !schema.items) return fromRef;
    return intersectConstraints(
      fromRef,
      propertyConstraint({ ...schema, $ref: undefined }, propertyName, resolveIrRef, seen),
    );
  }

  const parts: Array<DiscriminatorConstraint> = [];

  const property = schema.properties?.[propertyName];
  if (property) {
    parts.push(finiteValues(property, resolveIrRef, seen));
  }

  if (
    schema.items &&
    schema.type !== 'array' &&
    schema.type !== 'enum' &&
    schema.type !== 'tuple' &&
    (schema.logicalOperator === 'and' || schema.logicalOperator === 'or')
  ) {
    let combined: DiscriminatorConstraint | undefined;
    const combine = schema.logicalOperator === 'and' ? intersectConstraints : unionConstraints;
    for (const item of schema.items) {
      const next = propertyConstraint(item, propertyName, resolveIrRef, seen);
      combined = combined ? combine(combined, next) : next;
    }
    if (combined) parts.push(combined);
  }

  if (!parts.length) return { kind: 'absent' };
  return parts.reduce(intersectConstraints);
}

function toDiscriminatedValue(
  value: string,
  propertyType: DiscriminatorPropertyType | undefined,
): unknown {
  return propertyType && propertyType !== 'string'
    ? convertDiscriminatorValue(value, propertyType).const
    : value;
}

/**
 * OpenAPI's implicit mapping is the schema name. That name is a narrowing of
 * an unconstrained property, but it is `never` when the branch already limits
 * the property to other enum or const values. Prefer those values, and say so.
 */
function selectDiscriminatorValues({
  constraint,
  discriminatorKey,
  mapped,
  mapping,
  propertyType,
  ref,
}: {
  constraint: DiscriminatorConstraint;
  discriminatorKey: string;
  mapped: ReadonlyArray<string>;
  mapping?: Record<string, string>;
  propertyType: DiscriminatorPropertyType | undefined;
  ref: string;
}): ReadonlyArray<unknown> {
  // An explicit mapping is the wire value the spec author chose. Only the
  // implicit schema name is replaced, and only when it is not one of the
  // branch's own values — otherwise the intersection is `never`.
  if (!mapping && constraint.kind === 'values' && constraint.values.length) {
    const compatible = mapped.filter((value) =>
      constraint.values.some((candidate) => mappedMatches(value, candidate)),
    );
    if (!compatible.length) {
      console.warn(
        '🚨',
        `discriminator "${discriminatorKey}" for "${refToName(ref)}" maps to ${mapped
          .map((value) => JSON.stringify(value))
          .join(', ')}, which conflicts with the schema's own ${constraint.values
          .map((value) => JSON.stringify(value))
          .join(' | ')}; using the schema values`,
      );
      return constraint.values;
    }
  }

  return mapped.map((value) => toDiscriminatedValue(value, propertyType));
}

export interface DiscriminatedUnionMember {
  /** The discriminator value for this member. */
  discriminatedValue: unknown;
  /**
   * True when the referenced schema does not already define the discriminator
   * property as a const/literal. The plugin must inject it explicitly.
   */
  needsExtend: boolean;
  /** The resolved $ref string for this member. */
  ref: string;
}

export interface DiscriminatedUnionData {
  discriminatorKey: string;
  members: Array<DiscriminatedUnionMember>;
}

export function buildDiscriminatedUnion({
  parentSchema,
  resolveIrRef,
  schemas,
}: {
  parentSchema: IR.SchemaObject;
  resolveIrRef: (ref: string) => IR.SchemaObject | undefined;
  schemas: ReadonlyArray<IR.SchemaObject>;
}): DiscriminatedUnionData | null {
  const discriminatorKey = parentSchema.discriminator?.propertyName;
  if (!discriminatorKey) return null;

  const members: Array<DiscriminatedUnionMember> = [];

  for (const schema of schemas) {
    if (schema.type === 'null' || schema.const === null) continue;

    const ref = schema.$ref;
    if (!ref) return null;

    let resolved: IR.SchemaObject | undefined;
    try {
      resolved = resolveIrRef(ref);
    } catch {
      return null;
    }
    if (!resolved) return null;

    let effective = resolved;
    while (effective.$ref && !effective.type && !effective.properties && !effective.items) {
      try {
        const next = resolveIrRef(effective.$ref);
        if (!next) break;
        effective = next;
      } catch {
        break;
      }
    }

    const discriminatorProp = effective.properties?.[discriminatorKey];
    const isObjectLike = effective.type === 'object' || effective.logicalOperator === 'and';
    if (discriminatorProp?.const === undefined && !isObjectLike) return null;

    const mapped = discriminatorValues(ref, parentSchema.discriminator!.mapping);
    if (!mapped.length) return null;

    const propType = discriminatorProp?.type as DiscriminatorPropertyType | undefined;
    const constraint = propertyConstraint(effective, discriminatorKey, resolveIrRef, new Set());
    const values = selectDiscriminatorValues({
      constraint,
      discriminatorKey,
      mapped,
      mapping: parentSchema.discriminator!.mapping,
      propertyType: propType,
      ref,
    });
    if (!values.length) return null;

    // The branch schema already accepts exactly these values, so extending it
    // with the same literals would only override a correct enum or const.
    const coveredByBranch =
      constraint.kind === 'values' &&
      constraint.values.length === values.length &&
      constraint.values.every((value) => values.some((selected) => sameValue(selected, value)));
    const needsExtend = discriminatorProp?.const === undefined && !coveredByBranch;

    const emitted = new Set<string>();
    for (const discriminatedValue of values) {
      const key = discriminatorValueKey(discriminatedValue);
      if (emitted.has(key)) continue;
      emitted.add(key);
      members.push({
        discriminatedValue,
        needsExtend,
        ref,
      });
    }
  }

  const seenValues = new Map<string, string>();
  for (const member of members) {
    const key = discriminatorValueKey(member.discriminatedValue);
    const previous = seenValues.get(key);
    if (previous !== undefined && previous !== member.ref) return null;
    seenValues.set(key, member.ref);
  }

  if (!members.length) return null;

  return { discriminatorKey, members };
}
