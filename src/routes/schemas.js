// Fragmentos de JSON Schema reutilizados pelas rotas.

export const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
};

export const pagination = {
  limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  offset: { type: 'integer', minimum: 0, default: 0 },
};

/** FK opcional: aceita um ID ou null (para desassociar). */
export const nullableId = { type: ['integer', 'null'], minimum: 1 };

export const email = { type: 'string', format: 'email', maxLength: 190 };
export const password = { type: 'string', minLength: 8, maxLength: 128 };
