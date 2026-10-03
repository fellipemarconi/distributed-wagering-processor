import { type CanActivate, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão de autenticação: hoje aceita tudo (decisão e desenho pretendido em ARCHITECTURE.md).
 * Aplicado com @UseGuards nos controllers de negócio — não é global, então /health fica de fora.
 * Implementar autenticação = trocar este corpo (validar o JWT do IdP e comparar com o providerId).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
