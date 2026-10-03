# Arquitetura

Decisões, trade-offs e limitações. O enunciado está em [`CHALLENGE.md`](./CHALLENGE.md); o histórico detalhado de cada decisão está nos `design.md` em `openspec/changes/`.

## Camadas

```
src/domain/        regras e invariantes; sem NestJS, sem ORM (só decimal.js e node:crypto)
src/application/   use cases e portas (classes abstratas); sem NestJS, sem HTTP
src/infra/         adapters: MikroORM/PostgreSQL, SQS, relógio, ids
src/http/          controllers, AuthGuard, filtro de exceção
```

Os use cases (`CreateWallet`, `ProcessWagerTransaction`) são classes puras registradas por factory no `AppModule`. Eles recebem a entrada crua e devolvem um resultado tipado; o HTTP (e, depois, o consumidor SQS) só traduz esse resultado.

## Processamento de uma transação

`ProcessWagerTransaction.execute`:

1. **Fora da transação**: valida a entrada e calcula o `payloadHash`. Entrada inválida lança `InvalidPayloadError` — nada é gravado.
2. **Dentro de uma transação SQL**: `SELECT ... FOR UPDATE` na linha da wallet. Inexistente → `not-found`.
3. Busca por `(providerId, idempotencyKey)`: mesmo hash → `replay` com o resultado gravado; hash diferente → `conflict` (`IDEMPOTENCY_KEY_CONFLICT`). Mesmo `(providerId, externalTransactionId)` com outra chave → `conflict` (`EXTERNAL_TRANSACTION_CONFLICT`).
4. Decide, nesta ordem: jogador ≠ dono da wallet → `REJECTED`; moeda ≠ moeda da wallet → `REJECTED`; referência (`validateReference`: aguardar → `PENDING_REFERENCE`, rejeitar → `REJECTED`); aplica no saldo (`InsufficientFundsError` → `REJECTED`).
5. Grava transação (já no estado final: um `INSERT`, nenhum `UPDATE`), lançamento, saldo e eventos na outbox — tudo na mesma transação.
6. Se o banco recusar por unicidade de idempotência mesmo assim, relê em **nova** transação e devolve `replay` ou `conflict`.

### Concorrência

A unidade de concorrência é a wallet e a estratégia é **lock pessimista de linha** (`FOR UPDATE`). Não há lock global: wallets diferentes nunca se bloqueiam. Escolhido em vez de optimistic locking porque a wallet quente é o caso esperado — com retry otimista, N apostas simultâneas gerariam N−1 reexecuções; com o lock, cada uma espera a sua vez e executa uma vez só.

O lock também resolve a idempotência no caso comum: duplicatas da mesma requisição têm a mesma `walletId`, serializam no lock e a segunda já encontra a primeira gravada. O passo 6 cobre a corrida que escapa do lock (mesma chave ou mesmo id externo chegando com `walletId` diferentes); aí quem decide é o índice único, e a requisição perdedora vira `conflict` em vez de erro interno.

O código só decide; quem garante é o banco: unicidade de chave e de id externo, saldo não-negativo, ledger append-only e uma reversão aplicada por referência são constraints/índices/triggers do schema.

### `lock_timeout`

Toda conexão do pool usa `lock_timeout` (`DB_LOCK_TIMEOUT_MS`, padrão 5000). Sem limite, uma wallet travada seguraria conexões indefinidamente e a degradação se espalharia para outras wallets. Estourado o limite, a requisição falha como **transitória** (503 + `Retry-After`), nada é gravado e o reenvio com a mesma chave é seguro.

Descartados: `FOR UPDATE NOWAIT` (rejeitaria a contenção normal de wallet quente) e retry interno (o provedor já precisa saber reenviar).

Nos testes a configuração é a padrão (pool de 10 conexões do MikroORM, `lock_timeout` de 5s): a mesma aposta enviada 50 vezes em paralelo termina com 1 aplicada e 49 replays, sem nenhum 503, sem ajuste de ambiente. Só os testes que provocam o 503 de propósito sobem a aplicação com `lock_timeout` de 200ms.

## API HTTP — mapeamento de status

| Desfecho | Status | Corpo |
| --- | --- | --- |
| transação aplicada | 201 | transação, `idempotentReplay: false` |
| `PENDING_REFERENCE` | 202 | transação, sem `balance` |
| rejeição de negócio | 422 | transação com `failureCode` |
| replay | 200 aplicada / 202 pendente / 422 rejeitada | o resultado original, `idempotentReplay: true` |
| payload inválido, JSON malformado, `OPENING`, header ausente | 400 | erro `INVALID_PAYLOAD` / `MISSING_IDEMPOTENCY_KEY` |
| wallet ou transação inexistente | 404 | erro `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` |
| conflito | 409 | erro `IDEMPOTENCY_KEY_CONFLICT` / `EXTERNAL_TRANSACTION_CONFLICT` / `WALLET_ALREADY_EXISTS` |
| falha transitória de infraestrutura | 503 + `Retry-After` | erro `SERVICE_UNAVAILABLE` |
| erro inesperado | 500 | erro `INTERNAL_ERROR` (detalhe só no log) |

O que o provedor conclui só pelo status: **503** reenvie igual; **409** não reenvie, há outra transação com essa chave/id; **422** foi registrada e recusada, não reenvie; **400** corrija o payload; **202** aceita, consulte depois.

- Corpo de erro único: `{ "error": { "code", "message" } }`. `code` é estável; `message` é para humanos.
- **Rejeição devolve o corpo da transação, não o envelope de erro**: a transação existe, é consultável e o replay precisa devolver "a mesma resposta". O 422 sinaliza a recusa; o `failureCode` diz o motivo.
- `GET` de transação rejeitada ou pendente é 200: a consulta teve sucesso, o desfecho está em `status`.
- O filtro global de exceção é o único lugar que traduz exceção em resposta. Ele deixa `/health` com o tratamento padrão, porque o readiness tem contrato próprio de corpo.
- Ledger paginado: `limit` padrão 50, máximo 100 (acima disso é reduzido). O cursor é o `seq` do último lançamento em base64url — opaco para o cliente e estável, porque por wallet a ordem de `seq` é a ordem de commit.
- Falha transitória é reconhecida pelo código do driver (`isTransientInfraError`): `55P03` (lock_timeout), deadlock, falha de conexão, pool esgotado.

### Idempotência

- O header `Idempotency-Key` é obrigatório e é a fonte da verdade; a unicidade é por `(providerId, idempotencyKey)`.
- `payloadHash` = SHA-256 do JSON canônico (chaves ordenadas, `money` normalizado para 2 casas) dos campos de negócio. O header e campos desconhecidos não entram.
- O replay devolve o que foi **gravado**: status, `failureCode` e o saldo observado na decisão — não o saldo atual. Uma aposta rejeitada por falta de saldo continua rejeitada no replay, mesmo que a wallet tenha recebido crédito depois.

## Códigos de falha (`failureCode`)

Conjunto fechado e estável: só se adiciona, nunca se renomeia nem se reaproveita.

| Código | Significado | O provedor deve |
| --- | --- | --- |
| `INSUFFICIENT_FUNDS` | `BET` maior que o saldo | desistir (aposta recusada) |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversão debitaria além do saldo (ex.: `ROLLBACK` de `WIN` já gasto) | escalar para operação manual; não reenviar |
| `CURRENCY_MISMATCH` | moeda da transação ≠ moeda da wallet | corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | `playerId` do payload não é o dono da wallet | corrigir o payload |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do limite de espera | reenviar a referência e depois a reversão com novo id |
| `REFERENCE_MISMATCH` | referência é de outro provider, player, wallet, moeda ou rodada | corrigir o payload |
| `REFERENCE_KIND_NOT_ALLOWED` | tipo da referência não é reversível por esta operação | corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | referência terminou `REJECTED`/`FAILED`: não há efeito a reverter | desistir |
| `REFERENCE_ALREADY_REVERSED` | referência já tem reversão aplicada | desistir (já feito) |
| `REFERENCE_AMOUNT_MISMATCH` | valor ≠ valor da referência (reversão parcial fora de escopo) | corrigir o payload |
| `INTERNAL_ERROR` | erro permanente de infraestrutura (`FAILED`) | contatar suporte |

Interpretações adotadas:

- `WALLET_PLAYER_MISMATCH` e `CURRENCY_MISMATCH` são **rejeições gravadas** (422), não 400: o payload é bem formado e a tentativa fica auditável.
- "Uma referência não pode ser revertida duas vezes" vale entre tipos: `REFUND` + `ROLLBACK` da mesma `BET` creditaria a aposta duas vezes, então a segunda reversão é rejeitada qualquer que seja o tipo.
- Conflito de idempotência não é `failureCode`: nenhuma transação é criada.

## Autenticação — não implementada

Decisão consciente (CHALLENGE §2: não pontua e não deve competir com correção financeira).

**Ponto de extensão**: `src/http/auth.guard.ts` — um `AuthGuard` que hoje aceita tudo, aplicado com `@UseGuards(AuthGuard)` nos controllers de negócio. Não é um guard global, então os endpoints de health ficam de fora por construção. Um teste substitui o guard por um que nega tudo e verifica que todos os endpoints de negócio são negados e o health continua aberto.

**Desenho que seria adotado**: IdP externo (Keycloak) no Docker Compose, um client por provedor com *client credentials*. O guard validaria o JWT pelo JWKS do IdP e compararia a claim do provedor com o `providerId` do corpo ou da rota, respondendo 401/403 no envelope de erro. Sem tabela própria de usuários. Mensagens vindas da fila continuam sendo canal interno confiável, sujeitas às mesmas validações de domínio.

## Limitações conhecidas

- Os eventos são gravados na outbox mas ainda não publicados: o worker publicador, o consumidor SQS, o worker de `PENDING_REFERENCE` e a reconciliação são changes seguintes.
- Enquanto o worker de `PENDING_REFERENCE` não existir, uma transação pendente permanece pendente; o replay dela devolve 202.
- Sem retry automático no servidor: falha transitória volta como 503 e o provedor reenvia.
