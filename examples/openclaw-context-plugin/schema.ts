type JsonSchema = Record<string, unknown>;

function withDescription(schema: JsonSchema, description?: string): JsonSchema {
  return description ? { ...schema, description } : schema;
}

export const Schema = {
  String(options: { description?: string } = {}): JsonSchema {
    return withDescription({ type: "string" }, options.description);
  },

  Number(options: { description?: string } = {}): JsonSchema {
    return withDescription({ type: "number" }, options.description);
  },

  Boolean(options: { description?: string } = {}): JsonSchema {
    return withDescription({ type: "boolean" }, options.description);
  },

  Array(items: JsonSchema, options: { description?: string } = {}): JsonSchema {
    return withDescription({ type: "array", items }, options.description);
  },

  Optional(schema: JsonSchema): JsonSchema {
    return { ...schema, __optional: true };
  },

  Object(properties: Record<string, JsonSchema>): JsonSchema {
    const normalizedProperties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const [key, schema] of Object.entries(properties)) {
      if (schema.__optional === true) {
        const { __optional: _optional, ...rest } = schema;
        normalizedProperties[key] = rest;
        continue;
      }
      normalizedProperties[key] = schema;
      required.push(key);
    }

    return {
      type: "object",
      additionalProperties: false,
      properties: normalizedProperties,
      ...(required.length > 0 ? { required } : {}),
    };
  },
};
