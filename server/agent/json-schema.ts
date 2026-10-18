/**
 * Conversão de esquemas zod para JSON Schema (o formato que os modelos recebem).
 * Cobre apenas os tipos usados pelas ferramentas: objeto, texto, número,
 * inteiro, booleano, lista, enumeração, opcional e valor por defeito.
 * Um tipo não suportado lança erro no arranque, em vez de enviar um esquema errado.
 */
import { z } from 'zod';

type Json = Record<string, unknown>;

export function toJsonSchema(schema: z.ZodTypeAny): Json {
  const description = schema.description;
  const withDesc = (j: Json): Json => (description ? { ...j, description } : j);
  const def = schema._def as { typeName: z.ZodFirstPartyTypeKind };

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Json = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = toJsonSchema(value as z.ZodTypeAny);
        if (!(value as z.ZodTypeAny).isOptional()) required.push(key);
      }
      return withDesc({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
    }
    case z.ZodFirstPartyTypeKind.ZodString: {
      const checks = (schema as z.ZodString)._def.checks;
      const out: Json = { type: 'string' };
      for (const c of checks) {
        if (c.kind === 'min') out.minLength = c.value;
        if (c.kind === 'max') out.maxLength = c.value;
      }
      return withDesc(out);
    }
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const checks = (schema as z.ZodNumber)._def.checks;
      const out: Json = { type: checks.some((c) => c.kind === 'int') ? 'integer' : 'number' };
      for (const c of checks) {
        if (c.kind === 'min') out.minimum = c.value;
        if (c.kind === 'max') out.maximum = c.value;
      }
      return withDesc(out);
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return withDesc({ type: 'boolean' });
    case z.ZodFirstPartyTypeKind.ZodArray:
      return withDesc({ type: 'array', items: toJsonSchema((schema as z.ZodArray<z.ZodTypeAny>).element) });
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return withDesc({ type: 'string', enum: [...(schema as z.ZodEnum<[string, ...string[]]>).options] });
    case z.ZodFirstPartyTypeKind.ZodOptional: {
      const inner = toJsonSchema((schema as z.ZodOptional<z.ZodTypeAny>).unwrap());
      return description ? { ...inner, description } : inner;
    }
    case z.ZodFirstPartyTypeKind.ZodDefault: {
      const d = (schema as z.ZodDefault<z.ZodTypeAny>)._def;
      const inner = toJsonSchema(d.innerType);
      return { ...inner, default: d.defaultValue(), ...(description ? { description } : {}) };
    }
    default:
      throw new Error(`Tipo zod não suportado no esquema de ferramenta: ${def.typeName}`);
  }
}
