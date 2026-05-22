import { z } from "zod";

function applyMeta(schema, node) {
  let out = schema;
  if (typeof node?.description === "string" && node.description) {
    out = out.describe(node.description);
  }
  if (node?.default !== undefined) {
    out = out.default(node.default);
  }
  return out;
}

function literalUnion(values = []) {
  if (values.length === 0) return z.any();
  if (values.length === 1) return z.literal(values[0]);
  return z.union(values.map((value) => z.literal(value)));
}

export function typeBoxNodeToZod(node) {
  if (!node || typeof node !== "object") return z.any();

  if (Array.isArray(node.anyOf)) {
    const branches = node.anyOf.map((item) => typeBoxNodeToZod(item));
    if (branches.length === 1) return branches[0];
    return applyMeta(z.union(branches), node);
  }

  if (node.const !== undefined) {
    return applyMeta(z.literal(node.const), node);
  }

  if (Array.isArray(node.enum)) {
    return applyMeta(literalUnion(node.enum), node);
  }

  switch (node.type) {
    case "string":
      return applyMeta(z.string(), node);
    case "number":
    case "integer":
      return applyMeta(z.number(), node);
    case "boolean":
      return applyMeta(z.boolean(), node);
    case "null":
      return applyMeta(z.null(), node);
    case "array":
      return applyMeta(z.array(typeBoxNodeToZod(node.items)), node);
    case "object": {
      const shape = typeBoxObjectToZodShape(node);
      let objectSchema = z.object(shape);

      let catchallSchema = null;
      const patternProps = (node.patternProperties && typeof node.patternProperties === "object")
        ? Object.values(node.patternProperties)
        : [];
      if (patternProps.length > 0) {
        const branches = patternProps.map((item) => typeBoxNodeToZod(item));
        catchallSchema = branches.length === 1 ? branches[0] : z.union(branches);
      } else if (node.additionalProperties && typeof node.additionalProperties === "object") {
        catchallSchema = typeBoxNodeToZod(node.additionalProperties);
      }

      if (catchallSchema) {
        objectSchema = objectSchema.catchall(catchallSchema);
      }
      return applyMeta(objectSchema, node);
    }
    default:
      return applyMeta(z.any(), node);
  }
}

export function typeBoxObjectToZodShape(schema) {
  const properties = schema?.properties || {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const shape = {};
  for (const [key, value] of Object.entries(properties)) {
    let field = typeBoxNodeToZod(value);
    if (!required.has(key)) {
      field = field.optional();
    }
    shape[key] = field;
  }
  return shape;
}
