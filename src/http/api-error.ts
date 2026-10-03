import { type ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { InvalidPayloadError } from '../application/input';
import { isTransientInfraError } from '../infra/persistence/transient-error';

interface ErrorBody {
  error: { code: string; message: string };
}

/** Erro já no formato único da API: { error: { code, message } }. */
export function apiError(status: number, code: string, message: string): HttpException {
  return new HttpException({ error: { code, message } } satisfies ErrorBody, status);
}

export const correlationIdOf = (header: string | undefined): string => header?.trim() || randomUUID();

const RETRY_AFTER_SECONDS = '1';
const CODE_BY_STATUS: Record<number, string> = {
  400: 'INVALID_PAYLOAD',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
};

/**
 * Único lugar que traduz exceção em resposta. Tudo que não é erro conhecido vira 500 genérico:
 * o detalhe vai para o log, nunca para o corpo.
 */
@Catch()
export class ApiExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  override catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    // /health tem contrato próprio de corpo (estado das dependências): segue o tratamento padrão
    if (http.getRequest<{ url: string }>().url.startsWith('/health')) return super.catch(exception, host);

    const { status, body } = this.describe(exception);
    const response = http.getResponse<{
      setHeader(name: string, value: string): void;
      status(code: number): { json(body: unknown): void };
    }>();
    if (status === 503) response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    response.status(status).json(body);
  }

  private describe(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof InvalidPayloadError) {
      return { status: 400, body: { error: { code: 'INVALID_PAYLOAD', message: exception.message } } };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'object' && 'error' in response && typeof response.error === 'object') {
        return { status, body: response as ErrorBody };
      }
      // exceções do próprio Nest (rota inexistente, JSON malformado, guard negando)
      const code = CODE_BY_STATUS[status] ?? `HTTP_${status}`;
      return { status, body: { error: { code, message: exception.message } } };
    }
    if (isTransientInfraError(exception)) {
      this.logger.warn(`falha transitória de infraestrutura (${(exception as Error).name})`);
      const message = 'Serviço temporariamente indisponível; reenvie a mesma requisição';
      return { status: 503, body: { error: { code: 'SERVICE_UNAVAILABLE', message } } };
    }
    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Erro interno' } } };
  }
}
