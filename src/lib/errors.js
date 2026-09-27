/**
 * Erros de domínio com status HTTP e código estável (o frontend pode tratar pelo `code`).
 * Formato de resposta de erro de toda a API:
 *   { statusCode, error, code, message, details? }
 */
export class AppError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Não autenticado.') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Sem permissão para esta operação.') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (entity = 'Recurso') => new AppError(404, 'NOT_FOUND', `${entity} não encontrado.`);
export const conflict = (message, details) => new AppError(409, 'CONFLICT', message, details);

const HTTP_NAMES = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
};

function send(reply, statusCode, code, message, details) {
  const body = { statusCode, error: HTTP_NAMES[statusCode] ?? 'Error', code, message };
  if (details !== undefined) body.details = details;
  return reply.code(statusCode).send(body);
}

/** Traduz erros do MySQL para respostas HTTP úteis. */
function fromMysql(err) {
  switch (err.code) {
    case 'ER_DUP_ENTRY':
      return [409, 'DUPLICATE', 'Já existe um registo com estes dados.'];
    case 'ER_NO_REFERENCED_ROW_2':
      return [422, 'INVALID_REFERENCE', 'Um dos IDs relacionados (utilizador, cliente ou lead) não existe.'];
    case 'ER_ROW_IS_REFERENCED_2':
      return [409, 'IN_USE', 'O registo está a ser usado por outros dados e não pode ser removido.'];
    default:
      return null;
  }
}

export function registerErrorHandlers(app) {
  app.setErrorHandler((err, request, reply) => {
    if (err.validation) {
      return send(
        reply,
        400,
        'VALIDATION_ERROR',
        'Dados inválidos.',
        err.validation.map((v) => ({
          field: v.params?.missingProperty ?? v.instancePath.replace(/^\//, '').replace(/\//g, '.') ?? '',
          message: v.message,
        })),
      );
    }

    if (err instanceof AppError) {
      return send(reply, err.statusCode, err.code, err.message, err.details);
    }

    const mysql = fromMysql(err);
    if (mysql) return send(reply, ...mysql);

    // Erros 4xx do próprio Fastify/plugins (JSON malformado, rate limit, body grande...).
    if (err.statusCode >= 400 && err.statusCode < 500) {
      return send(reply, err.statusCode, err.code || 'CLIENT_ERROR', err.message);
    }

    request.log.error({ err }, 'Erro não tratado');
    return send(reply, 500, 'INTERNAL_ERROR', 'Erro interno. Tente novamente em instantes.');
  });

  app.setNotFoundHandler((request, reply) =>
    send(reply, 404, 'ROUTE_NOT_FOUND', `Rota ${request.method} ${request.url.split('?')[0]} não existe.`),
  );
}
