import type { IR } from '../../../../ir/types';
import { buildDiscriminatedUnion } from '../discriminator';

const catRef = '#/components/schemas/Cat';
const dogRef = '#/components/schemas/Dog';
const birdRef = '#/components/schemas/Bird';
const namedRef = '#/components/schemas/Named';
const otherRef = '#/components/schemas/Other';
const quuxRef = '#/components/schemas/Quux';

function enumOf(...values: Array<unknown>): IR.SchemaObject {
  return {
    items: values.map((value) => ({
      const: value,
      type: typeof value === 'number' ? 'number' : 'string',
    })),
    type: 'enum',
  };
}

function objectSchema(
  properties: Record<string, IR.SchemaObject>,
  extra?: Partial<IR.SchemaObject>,
): IR.SchemaObject {
  return {
    properties,
    type: 'object',
    ...extra,
  };
}

const schemas: Record<string, IR.SchemaObject> = {
  '#/components/schemas/AutoConfig': objectSchema({
    auto_setting: { type: 'string' },
    use_custom: { const: false, type: 'boolean' },
  }),
  '#/components/schemas/Bar': objectSchema({
    id: { type: 'string' },
    type: { $ref: quuxRef },
  }),
  '#/components/schemas/Bird': {
    items: [
      objectSchema({
        type: enumOf('bird', 'avian'),
        wings: { type: 'boolean' },
      }),
    ],
    logicalOperator: 'and',
  },
  '#/components/schemas/Cat': objectSchema({
    meow: { type: 'boolean' },
    type: enumOf('cat'),
  }),
  '#/components/schemas/Dog': objectSchema({
    bark: { type: 'boolean' },
    type: { const: 'dog', type: 'string' },
  }),
  '#/components/schemas/Named': objectSchema({
    extra: { type: 'boolean' },
    type: enumOf('Named', 'named'),
  }),
  '#/components/schemas/Other': objectSchema({
    note: { type: 'string' },
    type: { type: 'string' },
  }),
  '#/components/schemas/Quux': enumOf('Bar', 'Baz'),
};

function resolveIrRef(ref: string): IR.SchemaObject | undefined {
  return schemas[ref];
}

function unionOf(refs: ReadonlyArray<string>, mapping?: Record<string, string>): IR.SchemaObject {
  return {
    discriminator: {
      ...(mapping ? { mapping } : {}),
      propertyName: 'type',
    },
    items: refs.map((ref) => ({ $ref: ref })),
    logicalOperator: 'or',
  };
}

describe('buildDiscriminatedUnion', () => {
  it('uses a branch enum when the implicit schema name conflicts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = buildDiscriminatedUnion({
      parentSchema: unionOf([catRef]),
      resolveIrRef,
      schemas: [{ $ref: catRef }],
    });

    expect(result).toEqual({
      discriminatorKey: 'type',
      members: [{ discriminatedValue: 'cat', needsExtend: false, ref: catRef }],
    });
    expect(warn).toHaveBeenCalledWith(
      '🚨',
      expect.stringContaining('conflicts with the schema\'s own "cat"'),
    );
    warn.mockRestore();
  });

  it('uses a branch const when the implicit schema name conflicts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = buildDiscriminatedUnion({
      parentSchema: unionOf([dogRef]),
      resolveIrRef,
      schemas: [{ $ref: dogRef }],
    });

    expect(result?.members).toEqual([
      { discriminatedValue: 'dog', needsExtend: false, ref: dogRef },
    ]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reads an enum nested in allOf', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = buildDiscriminatedUnion({
      parentSchema: unionOf([birdRef]),
      resolveIrRef,
      schemas: [{ $ref: birdRef }],
    });

    expect(result?.members.map((member) => member.discriminatedValue)).toEqual(['bird', 'avian']);
    warn.mockRestore();
  });

  it('keeps the implicit name when the branch enum includes it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = buildDiscriminatedUnion({
      parentSchema: unionOf([namedRef]),
      resolveIrRef,
      schemas: [{ $ref: namedRef }],
    });

    expect(result?.members).toEqual([
      { discriminatedValue: 'Named', needsExtend: true, ref: namedRef },
    ]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps the implicit name when the property is an unconstrained string', () => {
    const result = buildDiscriminatedUnion({
      parentSchema: unionOf([otherRef]),
      resolveIrRef,
      schemas: [{ $ref: otherRef }],
    });

    expect(result?.members).toEqual([
      { discriminatedValue: 'Other', needsExtend: true, ref: otherRef },
    ]);
  });

  it('keeps a shared enum narrowed to the schema name', () => {
    const barRef = '#/components/schemas/Bar';
    const result = buildDiscriminatedUnion({
      parentSchema: unionOf([barRef]),
      resolveIrRef,
      schemas: [{ $ref: barRef }],
    });

    expect(result?.members).toEqual([
      { discriminatedValue: 'Bar', needsExtend: true, ref: barRef },
    ]);
  });

  it('keeps an explicit mapping that matches the branch const', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const autoRef = '#/components/schemas/AutoConfig';
    const result = buildDiscriminatedUnion({
      parentSchema: {
        discriminator: {
          mapping: { False: autoRef },
          propertyName: 'use_custom',
        },
        items: [{ $ref: autoRef }],
        logicalOperator: 'or',
      },
      resolveIrRef,
      schemas: [{ $ref: autoRef }],
    });

    expect(result?.members).toEqual([
      { discriminatedValue: false, needsExtend: false, ref: autoRef },
    ]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps an explicit mapping that is not one of the branch enum values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = buildDiscriminatedUnion({
      parentSchema: unionOf([catRef], { Cat: catRef }),
      resolveIrRef,
      schemas: [{ $ref: catRef }],
    });

    expect(result?.members).toEqual([
      { discriminatedValue: 'Cat', needsExtend: true, ref: catRef },
    ]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to a plain union when branch values collide', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const twinRef = '#/components/schemas/Twin';
    const collided = buildDiscriminatedUnion({
      parentSchema: unionOf([catRef, twinRef]),
      resolveIrRef: (ref) =>
        ref === twinRef
          ? objectSchema({
              bark: { type: 'boolean' },
              type: { const: 'cat', type: 'string' },
            })
          : schemas[ref],
      schemas: [{ $ref: catRef }, { $ref: twinRef }],
    });

    expect(collided).toBeNull();
    warn.mockRestore();
  });
});
