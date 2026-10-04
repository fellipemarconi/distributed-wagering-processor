# Arquitetura

Decisões, trade-offs e limitações. Como rodar e usar está no [`README.md`](./README.md).

1. [Visão geral e camadas](#visão-geral-e-camadas)
2. [Stack e ORM](#stack-e-orm) · [Mapeamento do Money](#mapeamento-do-money) · [Estratégia transacional](#estratégia-transacional)
3. [Concorrência](#concorrência)
4. [Idempotência](#idempotência)
5. [Máquina de estados da WagerTransaction](#máquina-de-estados-da-wagertransaction) · [Códigos de falha](#códigos-de-falha)
6. [Mapeamento de status HTTP](#mapeamento-de-status-http)
7. [Catálogo de constraints](#catálogo-de-constraints)
8. [Transactional outbox](#transactional-outbox) · [Consumidor da fila](#consumidor-da-fila) · [Worker de PENDING_REFERENCE](#worker-de-pending_reference)
9. [Reconciliação](#reconciliação)
10. [Observabilidade](#observabilidade)
11. [Autenticação](#autenticação)
12. [Interpretações adotadas do enunciado](#interpretações-adotadas-do-enunciado)
13. [Testes obrigatórios (§13)](#testes-obrigatórios-13)
14. [Limitações conhecidas e o que faria com mais tempo](#limitações-conhecidas-e-o-que-faria-com-mais-tempo)

## Visão geral e camadas

```
 adapters de entrada
 ┌──────────────────┐ ┌──────────────────┐ ┌───────────────────────┐ ┌────────────────────────┐
 │ HTTP             │ │ SqsWagerConsumer │ │ OutboxPublisherWorker │ │ PendingReferenceWorker │
 │ src/http/        │ │ src/infra/       │ │ src/infra/            │ │ src/infra/             │
 └────────┬─────────┘ └────────┬─────────┘ └───────────┬───────────┘ └───────────┬────────────┘
          │                    │                       │                         │
          ▼                    ▼                       ▼                         ▼
 use cases — src/application/ (classes puras, sem NestJS nem ORM)
 ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 │ CreateWallet · ProcessWagerTransaction · ProcessWagerMessage · ReconcileWallet           │
 │ PublishOutboxBatch · ReprocessPendingReferences · WagerDecision (regras compartilhadas)  │
 │                                                                                          │
 │ ports.ts: WalletRepository · WagerTransactionRepository · LedgerRepository               │
 │           InboxRepository · OutboxRepository · TransactionRunner · EventPublisher        │
 │           IdGenerator · Clock                                                            │
 └───────────────┬──────────────────────────────────────────────────▲───────────────────────┘
                 │ usa                                              │ implementam as portas
                 ▼                                                  │
 domínio — src/domain/                                 adapters de saída
 ┌───────────────────────────────────────────┐         ┌──────────────────────────────────────┐
 │ Money · Wallet · WalletLedgerEntry        │         │ src/infra/persistence/ (MikroORM)    │
 │ WagerTransaction · validateReference      │         │ src/infra/sqs-event-publisher.ts     │
 │ computePayloadHash · FailureCode          │         │ src/infra/system.ts (UUID v7, relógio)│
 │ InboxMessage · OutboxMessage · eventos    │         └──────────────────────────────────────┘
 └───────────────────────────────────────────┘
```

- **Domínio (`src/domain/`)** — só importa `decimal.js`, `node:crypto` e arquivos do próprio domínio. `test/domain/purity.test.ts` varre os imports e falha se aparecer qualquer outra coisa. O domínio também não gera ids nem lê o relógio: os dois chegam por parâmetro, então os testes unitários são determinísticos e rodam sem Docker.
- **Aplicação (`src/application/`)** — um use case por arquivo, mais `ports.ts` (portas), `input.ts` (validação de entrada compartilhada por HTTP e fila) e `wager-decision.ts` (regras de decisão, ponto único usado pela submissão e pelo worker de pendentes). Não conhece NestJS nem MikroORM: as portas são **classes abstratas**, que servem de tipo e de token de injeção ao mesmo tempo, e os use cases são registrados no `AppModule` por `useFactory`.
- **Adapters** — de entrada: controllers (`src/http/`), consumidor SQS e os dois workers (`src/infra/`). De saída: repositórios e `MikroOrmTransactionRunner` (`src/infra/persistence/`), `SqsEventPublisher`, gerador de id e relógio (`src/infra/system.ts`).
- **O resultado dos use cases não tem noção de transporte.** `ProcessWagerTransaction` devolve `processed | rejected | pending | replay | conflict | not-found`; o controller traduz em status HTTP e o consumidor em ack, DLQ ou retry. É o que permite HTTP e fila usarem o **mesmo** use case.
- **Consultas `GET`** leem os repositórios direto do controller: são leituras de uma linha, e um use case por consulta seria só repasse.
- **Use cases devolvem fatos; adapters contam e logam.** Não existe porta de métricas nem de log (ver [Observabilidade](#observabilidade)).

## Stack e ORM

A stack é a do enunciado (§4): Bun 1.x, TypeScript estrito, NestJS (adapter Express), PostgreSQL 17, SQS via LocalStack, Docker Compose. Não há etapa de build: o Bun executa o TypeScript direto. Fora dela há três dependências: `decimal.js` (dinheiro), `@aws-sdk/client-sqs` e `prom-client` (ver [Observabilidade](#observabilidade)). Validação de entrada, configuração, health checks e logger são código próprio curto em vez de `class-validator`, `@nestjs/config`, `@nestjs/terminus` e `pino`.

### Por que MikroORM

É a opção preferencial do enunciado, e três recursos dele sustentam o desenho:

- **`em.transactional()` com `AsyncLocalStorage`**: os repositórios recebem o `EntityManager` injetado e resolvem sozinhos a transação corrente. O use case chama `runner.run(work)` sem receber nem repassar um objeto de transação — é o que mantém `src/application/` sem dependência do ORM.
- **`LockMode`**: `PESSIMISTIC_WRITE` (`FOR UPDATE`) na wallet e `PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`) nos claims da outbox e das pendentes, sem SQL manual.
- **`EntitySchema`**: o mapeamento fica em `src/infra/persistence/schemas.ts`, sem decorators nas classes de domínio.

O que **não** é usado, de propósito: Unit of Work e Identity Map. O agregado de domínio é a unidade de mudança; o registro do ORM é descartável (ver [Estratégia transacional](#estratégia-transacional)).

### Migrations em SQL escrito à mão

A migration (`src/migrations/`) é a fonte da verdade do schema; os `EntitySchema` só mapeiam colunas e nada é gerado a partir deles (`snapshot: false`, `migration:create --blank`). O gerador não expressa CHECK composto, índice parcial nem trigger — justamente o que o enunciado avalia (§5 item 9). O risco de o SQL e o mapeamento divergirem é coberto pelos testes de round-trip de todos os agregados em todos os estados.

`kind`, `status` e `direction` são `text` + `CHECK`, não `ENUM` do Postgres: não existe `ALTER TYPE ... DROP VALUE`, então acrescentar um valor a um `ENUM` não teria `down()`.

## Mapeamento do Money

`number` nunca toca um valor monetário, da entrada ao banco:

1. **Entrada** — `Money.from({ amount, currency })` valida por regex **antes** de criar o `Decimal`: `amount` é uma string que casa `^\d{1,17}(\.\d{1,2})?$` e `currency` casa `^[A-Z]{3}$`. A regex sozinha elimina `NaN`, `Infinity`, notação científica, string vazia, espaços, sinal, vírgula e mais de 2 casas — nada chega a ser arredondado. Os 17 dígitos inteiros são o limite do `NUMERIC(19,2)`: o overflow é recusado na entrada, não no banco.
2. **Aritmética** — `decimal.js` com precisão 40 (o padrão de 20 dígitos significativos arredondaria somas no limite da coluna). `Money` é imutável (`Object.freeze`); operação entre moedas diferentes lança `CurrencyMismatchError`.
3. **Negativos** — `from` os rejeita. Só existem como resultado de `subtract`/`negate` (a `difference` da reconciliação) e nunca são persistidos.
4. **Banco** — `NUMERIC(19,2)`. A propriedade é `decimal(19,2)` no `EntitySchema` e o tipo do registro é `string`: o driver `pg` devolve `NUMERIC` como string e o MikroORM a mantém assim.
5. **Mapper** (`mappers.ts`) — escreve `money.toJSON().amount` e lê com `Money.from({ amount, currency })`. Não há `Type` customizado do ORM: o mapper já é o único lugar que conhece os dois lados. Como nenhuma coluna persistida é negativa (CHECKs), a mesma factory de entrada serve para reidratar.
6. **Moeda** — uma coluna `currency` por linha em `wallets`, `wager_transactions` e `wallet_ledger_entries` (no ledger, valor, saldo anterior e posterior são sempre da mesma moeda). A exceção é `wager_transactions.result_balance_currency`: o saldo observado é o da wallet e, numa rejeição por `CURRENCY_MISMATCH`, está em moeda diferente da transação.
7. **Saída** — `toJSON()` serializa sempre com 2 casas (`toFixed(2)`). Eventos carregam `MoneyProps`, nunca a instância.

## Estratégia transacional

A porta é `TransactionRunner`, com dois métodos:

| Método | Implementação | Uso |
| --- | --- | --- |
| `run(work)` | `em.transactional(work)`, `READ COMMITTED` | toda escrita: uma requisição, uma mensagem, uma candidata do worker ou um lote da outbox = uma transação SQL |
| `snapshot(work)` | `em.transactional(work, { isolationLevel: REPEATABLE READ, readOnly: true })` | reconciliação: leitura em uma única foto, sem lock (ver [Reconciliação](#reconciliação)) |

- **Tudo ou nada.** Transação, saldo, lançamento, inbox (quando a entrada é a fila) e eventos da outbox são gravados dentro do mesmo `run`. Erro lançado em `work` desfaz tudo e é propagado sem embrulho.
- **Escrita imediata** — os repositórios usam `em.insert` e `em.nativeUpdate`, não `persist` + `flush`. Dois ganhos sobre o flush adiado: a ordem dos comandos é a do código (as FKs exigem transação antes do lançamento) e o erro de constraint aparece **na chamada que o causou** — o use case precisa saber qual gravação colidiu para distinguir replay de conflito. `save` exige exatamente uma linha afetada: zero linhas é erro, não no-op silencioso.
- **Leitura sem Identity Map** (`disableIdentityMap: true`) — nenhum registro fica em cache, então `findByIdForUpdate` devolve o que está no banco **depois** de obter o lock. Com o Identity Map, o ORM devolveria a instância já carregada e só emitiria o lock: leitura obsoleta, exatamente o lost update que o lock deveria impedir.
- **`run` é reentrante** — chamado dentro de outro `run`, vira um **savepoint** na mesma conexão. É assim que o consumidor cobre inbox e efeito financeiro com um único commit sem alterar o use case da HTTP (ver [Consumidor da fila](#consumidor-da-fila)). O contrato está na porta e tem teste próprio (`run dentro de run participa da transação externa`).
- **Só unicidade é traduzida** — `UniqueConstraintViolationException` vira `UniqueViolationError { constraint }`, e o nome da constraint é o contrato com o use case. CHECK, FK e trigger violados indicam bug e estouram como vieram.
- **Sem retry dentro do servidor** — falha transitória (lock timeout, deadlock, conexão) desfaz a transação e volta ao chamador: `503` na HTTP, reentrega na fila. A idempotência torna o reenvio seguro.

## Concorrência

A unidade de concorrência é a wallet (§8). Toda operação que pode mudar um saldo começa com `SELECT ... FOR UPDATE` **na linha daquela wallet** (`WalletRepository.findByIdForUpdate`). Não existe lock global nem de tabela: wallets diferentes nunca se bloqueiam.

### Por que pessimista

- **A seção crítica é maior que o saldo.** Com a wallet travada, a mesma transação lê a idempotência, resolve a referência, verifica se ela já foi revertida, decide e grava. Duplicatas da mesma requisição têm a mesma `walletId`, então se serializam no lock e a segunda já encontra a primeira gravada: 50 envios paralelos viram 1 aplicação e 49 replays, sem nenhuma violação de unicidade nem erro. A verificação "referência já revertida" também fica livre de corrida, porque uma referência válida é da mesma wallet.
- **Optimistic locking** (`version` + retry) pune exatamente o caso que importa, a hot wallet: todas as concorrentes menos uma falham e repetem o trabalho, com um limite de tentativas a escolher. O lock transforma a disputa em fila.
- **`FOR UPDATE NOWAIT`** rejeitaria a contenção normal de uma wallet quente; esperar um pouco é o comportamento certo.
- **`version`** continua existindo: é incrementada pelo domínio, só quando o saldo muda, e vai no evento `WalletBalanceChanged` (`walletVersion`) para o consumidor ordenar. Não é marcada como versão do ORM — a garantia contra lost update é o lock.

### `lock_timeout` e o `503`

`DB_LOCK_TIMEOUT_MS` (padrão 5000) é aplicado como parâmetro de sessão em toda conexão do pool (`-c lock_timeout=...` em `src/mikro-orm.config.ts`). Sem ele, uma wallet travada seguraria conexões indefinidamente e a degradação se espalharia para as outras wallets. Estourado o limite, o Postgres responde SQLSTATE `55P03`, nada é gravado e a falha é classificada como transitória (`isTransientInfraError`):

- HTTP: `503` + `Retry-After: 1`; o provedor reenvia a mesma requisição;
- fila: a mensagem não é apagada e volta com backoff;
- worker de pendentes: só aquela candidata é desfeita e continua vencida.

### Ordem de locks e ausência de deadlock

| Caminho | Ordem |
| --- | --- |
| Submissão (`ProcessWagerTransaction`) | 1. `FOR UPDATE` na wallet → 2. leituras sem lock (idempotência, referência) → 3. `INSERT` da transação, lançamento, `UPDATE` da wallet, outbox → 4. `UPDATE` que antecipa as pendentes que aguardavam esta transação |
| Worker (`ReprocessPendingReferences`) | 1. `FOR UPDATE` na wallet → 2. `FOR UPDATE SKIP LOCKED` na transação pendente → 3. `UPDATE ... WHERE status = 'PENDING_REFERENCE'`, lançamento, wallet, outbox → 4. antecipação |
| Publisher da outbox | só `FOR UPDATE SKIP LOCKED` em linhas da outbox; nunca toca wallet nem transação |
| Reconciliação | nenhum lock |

- **Wallet sempre antes de transação**, nos dois caminhos que travam as duas.
- **Uma transação SQL trava uma única wallet**: não existe ciclo wallet ↔ wallet.
- **O worker nunca espera por linha de transação** (`SKIP LOCKED`). Dois workers com a mesma candidata se serializam na wallet; o segundo relê depois de obter o lock e encontra a transação terminal ou reagendada.
- **A antecipação** (passo 4) é o único `UPDATE` que pode esperar por uma linha travada por um worker. Não fecha ciclo: esse worker só depende do lock da própria wallet, que já tem.
- Se ainda assim o Postgres detectar um deadlock (`40P01`), ele é tratado como falha transitória, igual ao lock timeout.

### Constraints como rede de segurança

O lock é a estratégia; o schema é a garantia. Se a ordem de lock for quebrada por código futuro, o banco recusa o resultado em vez de gravá-lo: `ck_wallets_balance_non_negative` (saldo negativo), `uq_ledger_transaction_wallet` (segundo lançamento da mesma transação), `uq_wager_tx_processed_reversal` (segunda reversão aplicada), as duas unicidades de idempotência e o `UPDATE` condicionado ao estado no worker. Lista completa em [Catálogo de constraints](#catálogo-de-constraints).

Nada disso depende de estado em memória: todas as instâncias decidem pelo banco, então a solução é a mesma com 1 ou N processos.

## Idempotência

### Chave e escopo

O header `Idempotency-Key` é obrigatório na HTTP e é a fonte da verdade — um `idempotencyKey` no corpo é sobrescrito por ele. Na fila, a chave vem de `data.idempotencyKey`. O escopo é o provedor: a unicidade é `(provider_id, idempotency_key)` (`uq_wager_tx_provider_idempotency_key`), porque a chave é escolhida pelo provedor e dois provedores podem usar a mesma string. A idempotência vive só no banco; não há cache.

### Algoritmo do `payloadHash`

`computePayloadHash` (`src/domain/payload-hash.ts`): SHA-256, em hex minúsculo, do JSON canônico dos campos de negócio.

1. **Allowlist** — só entram `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId`. `idempotencyKey`, `messageId`, `occurredAt`, headers e campos desconhecidos nunca entram.
2. **`money` normalizado** por `Money.from(...).toJSON()`: `"25"` e `"25.00"` são o mesmo payload. Valor inválido é rejeitado, não normalizado.
3. **`referenceExternalTransactionId` ausente é omitido** (não vira `null`).
4. **Serialização** com as chaves ordenadas recursivamente e sem espaços.
5. **`sha256`** de `node:crypto`, saída com 64 caracteres hexadecimais.

### Replay

Mesma chave e mesmo hash: a resposta é a **transação gravada**, com `idempotentReplay: true` — o status e o saldo observado **naquele momento** (`resultBalance`), não o saldo atual da wallet (§7 regra 7). Nada é reavaliado nem gravado, e nenhum evento novo é enfileirado. O status HTTP segue o estado gravado: `200` aplicada, `422` rejeitada, `202` ainda pendente. Uma pendente resolvida depois pelo worker passa a responder o estado terminal.

### Conflitos

| Situação | Código | Resultado |
| --- | --- | --- |
| mesma chave, payload diferente | `IDEMPOTENCY_KEY_CONFLICT` | HTTP `409`; na fila, DLQ |
| mesmo `(providerId, externalTransactionId)` com outra chave | `EXTERNAL_TRANSACTION_CONFLICT` | HTTP `409`; na fila, DLQ |

Nenhum dos dois é `FailureCode`: nenhuma transação é rejeitada, a requisição é recusada antes de existir transação, e a original fica intacta.

### Corrida fora do lock

O lock da wallet só serializa requisições com a mesma `walletId`. A mesma chave (ou o mesmo id externo) enviada em paralelo para wallets **diferentes** passa pelas duas leituras de idempotência e colide no `INSERT`. Quem decide é o banco: a constraint `uq_wager_tx_provider_idempotency_key` ou `uq_wager_tx_provider_external` aborta a transação perdedora, e o use case relê em um novo `run` — replay se o payload for o mesmo, conflito se não for. Se a releitura não achar nada (a vencedora desfez), o erro original é relançado; não há loop de retry.

### Inbox e idempotência entre canais

São duas barreiras diferentes, e a fila usa as duas:

- **Inbox** — deduplica a **mensagem**, por `(consumer_name, message_id)` (`pk_inbox_messages`). Cobre a reentrega da mesma mensagem.
- **Chave de idempotência** — deduplica a **operação**, em qualquer canal. A mesma transação enviada por HTTP e pela fila, ou em duas mensagens com `messageId` diferentes, tem um único efeito: a segunda é replay.

Falha transitória e wallet inexistente não gravam nada — nem transação, nem inbox —, então o reenvio é processado normalmente.

## Máquina de estados da WagerTransaction

```
                 ┌──────────────► PROCESSED  (terminal)
                 │ markProcessed
   create()      │  reject(code)
  ───────► PENDING ─────────────► REJECTED   (terminal)
              │  │
              │  │  fail(code)
              │  └──────────────► FAILED     (terminal)
              │
              │ markPendingReference()
              ▼
        PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
              │      ▲
              └──────┘ scheduleReferenceRetry()  (referência ainda ausente: conta a tentativa e reagenda)
```

| De \ Para | `PENDING_REFERENCE` | `PROCESSED` | `REJECTED` | `FAILED` |
| --- | --- | --- | --- | --- |
| `PENDING` | ✓ (só se informa referência) | ✓ | ✓ | ✓ |
| `PENDING_REFERENCE` | ✓ (continua aguardando) | ✓ | ✓ | ✓ |
| `PROCESSED` / `REJECTED` / `FAILED` | ✗ | ✗ | ✗ | ✗ |

- ✗ lança `InvalidTransactionStateError` e não muda nada: transicionar um estado terminal é erro de programação, não caminho de negócio. A regra é uma só ("terminal não transiciona"), então há um guard (`assertNotTerminal`) em vez de uma tabela de transições. Nenhuma transição volta para `PENDING`.
- `markProcessed` exige a referência resolvida para `REFUND` e `ROLLBACK`.
- **`resultBalance`** — saldo da wallet observado na decisão: o saldo posterior quando `PROCESSED` (para `LOSS`, o saldo inalterado) e o saldo corrente quando `REJECTED`. É o que o replay devolve. Por isso `markProcessed` e `reject` recebem o saldo, divergindo do esqueleto do enunciado, que não tem onde guardá-lo.
- **`completedAt`** — instante em que chegou a qualquer estado terminal. `processedAt` só existe em `PROCESSED`. Assim uma rejeição tem instante auditável sem sobrecarregar `processedAt`.
- **`REJECTED` × `FAILED`** — `REJECTED` é violação de regra de negócio; `FAILED` é erro permanente de infraestrutura, sem `resultBalance` (pode ocorrer antes de a wallet ser lida).
- `rehydrate` reconstrói qualquer estado sem validar.

No banco, a submissão grava a transação **já no estado decidido**, com um único `INSERT`: `PENDING` existe só em memória, entre `create()` e a decisão. O único `UPDATE` de estado é o do worker, que leva `PENDING_REFERENCE` a um estado terminal ou a reagenda.

**`FAILED` nunca é produzido, por decisão.** Como a transação é gravada já no estado final e em um único commit, uma falha de infraestrutura desfaz tudo: não existe transação parcial para marcar como `FAILED`. O provedor recebe `503`, ou a mensagem volta para a fila, e o reenvio é seguro porque nada foi gravado. Gravar um `FAILED` exigiria uma segunda transação logo depois de uma falha de banco, e transformaria um erro transitório em estado terminal, impedindo o reenvio com a mesma chave. O estado e o código `INTERNAL_ERROR` continuam no domínio e no schema como ponto de extensão, para um erro permanente que venha a existir.

Regras por tipo:

| Kind | Valor | Move saldo | Referência | Lançamento |
| --- | --- | --- | --- | --- |
| `OPENING` (interno) | > 0 | sim | não tem | `CREDIT` |
| `BET` | > 0 | sim | proibida | `DEBIT` |
| `WIN` | > 0 | sim | opcional (deve ser `BET`) | `CREDIT` |
| `LOSS` | ≥ 0 | não | opcional (deve ser `BET`) | nenhum |
| `REFUND` | > 0 | sim | obrigatória (`BET`) | `CREDIT` |
| `ROLLBACK` | > 0 | sim | obrigatória (`BET`, `WIN` ou `REFUND`) | inverso da referência |

`OPENING` não entra por `create()`: nasce por `WagerTransaction.opening()`, com `providerId = "internal"` e `externalTransactionId = opening:<walletId>`. `create()` recusa o `providerId` `internal`, para um provedor não colidir com (nem se passar por) a transação de abertura.

## Códigos de falha

`FailureCode` (`src/domain/failure-code.ts`) é o contrato com o provedor: o valor é estável, só se adiciona, nunca se renomeia nem se reaproveita. Um teste afirma que o enum é exatamente esta lista.

| Código | Significado | Origem | O provedor deve |
| --- | --- | --- | --- |
| `INSUFFICIENT_FUNDS` | `BET` maior que o saldo | débito na wallet | desistir (aposta recusada) |
| `REVERSAL_INSUFFICIENT_FUNDS` | a reversão debitaria além do saldo (ex.: `ROLLBACK` de um `WIN` já gasto) | débito na wallet | escalar para operação manual; não reenviar |
| `CURRENCY_MISMATCH` | moeda da transação ≠ moeda da wallet | decisão | corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | `playerId` do payload não é o dono da wallet | decisão | corrigir o payload |
| `REFERENCE_NOT_FOUND` | a referência não foi resolvida no prazo (não chegou, ou chegou e continua pendente) | worker de pendentes | enviar a referência e depois a reversão com novo id |
| `REFERENCE_MISMATCH` | a referência é de outro provider, player, wallet, moeda ou rodada | validação da referência | corrigir o payload |
| `REFERENCE_KIND_NOT_ALLOWED` | o tipo da referência não é aceito por esta operação | validação da referência | corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | a referência terminou `REJECTED` ou `FAILED`: não há efeito a reverter | validação da referência | desistir |
| `REFERENCE_ALREADY_REVERSED` | a referência já tem uma reversão aplicada | validação da referência | desistir (já feito) |
| `REFERENCE_AMOUNT_MISMATCH` | valor ≠ valor da referência (reversão parcial está fora de escopo) | validação da referência | corrigir o payload |
| `INTERNAL_ERROR` | erro permanente de infraestrutura (`FAILED`) | `fail()` | contatar o suporte |

- **Dois códigos para saldo insuficiente** (§7 regra 9): aposta sem saldo é rotina; reversão sem saldo pede intervenção.
- **`REFERENCE_MISMATCH` é um código só** para os cinco campos: a ação do provedor é a mesma.
- **Ordem das verificações** (a primeira que falhar decide): jogador, moeda, e então a referência — existência, identidade, tipo, estado, reversão anterior, valor. Identidade e tipo vêm antes do estado para rejeitar uma referência errada na hora, sem esperar ela finalizar.
- **`FailureCode` não é exceção.** Erro lançado é bug ou entrada inválida; `FailureCode` é resultado de negócio gravado e auditável. A ponte é `WagerDecision`, que captura `InsufficientFundsError` e chama `tx.reject(...)`.
- **Conflito de idempotência não é `FailureCode`** (ver [Idempotência](#idempotência)), e o `INTERNAL_ERROR` do corpo de um `500` é o código do envelope de erro HTTP, não uma transação `FAILED`.

## Mapeamento de status HTTP

Um único lugar decide cada metade: `statusOf` (`src/http/wagering.controller.ts`) para desfechos com transação e `ApiExceptionFilter` (`src/http/api-error.ts`) para erros.

| Situação | Status | Corpo |
| --- | --- | --- |
| transação aplicada | `201` | transação, `idempotentReplay: false` |
| replay de transação aplicada | `200` | a mesma transação, `idempotentReplay: true` |
| aguardando referência (primeira vez ou replay) | `202` | transação sem `balance` |
| rejeitada por regra de negócio (primeira vez ou replay) | `422` | transação com `failureCode` e `balance` |
| header `Idempotency-Key` ausente | `400` | erro `MISSING_IDEMPOTENCY_KEY` |
| payload inválido (JSON malformado, campo ausente, `OPENING`, id ou cursor malformado) | `400` | erro `INVALID_PAYLOAD` |
| guard de autenticação negou | `401` / `403` | erro `UNAUTHORIZED` / `FORBIDDEN` |
| wallet, transação ou rota inexistente | `404` | erro `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` / `NOT_FOUND` |
| conflito de idempotência | `409` | erro `IDEMPOTENCY_KEY_CONFLICT` / `EXTERNAL_TRANSACTION_CONFLICT` |
| wallet duplicada para jogador + moeda | `409` | erro `WALLET_ALREADY_EXISTS` |
| falha transitória (banco fora, lock timeout, deadlock, pool esgotado) | `503` + `Retry-After: 1` | erro `SERVICE_UNAVAILABLE` |
| qualquer outro erro | `500` | erro `INTERNAL_ERROR`; o detalhe só vai para o log |
| consulta (`GET`) de wallet, ledger ou transação — inclusive rejeitada ou pendente | `200` | o recurso |
| wallet criada | `201` | a wallet |
| reconciliação, consistente ou divergente | `200` | resultado com `consistent` |

- **O provedor decide pelo status, sem ler mensagem**: `503` reenvia igual; `409` e `400` corrigem; `422` é definitivo e o `failureCode` diz por quê; `202` aguarda ou consulta.
- **Rejeição devolve a transação, não o envelope de erro.** A transação existe, é consultável, e o replay precisa devolver a mesma resposta. O envelope `{ "error": { "code", "message" } }` fica para respostas que não produziram transação.
- **`GET` de transação rejeitada é `200`**: a consulta teve sucesso; o desfecho está em `status`.
- **Divergência na reconciliação é `200`**: a verificação funcionou; quem sinaliza é `consistent: false`.
- `/health` mantém o corpo próprio (estado das dependências) e não passa pelo envelope.
- Todas as linhas têm teste em `test/http/api.integration.test.ts` (a reconciliação, em `test/reconciliation/`), exceto o `401`: o código está mapeado, mas nenhum fluxo o produz enquanto o guard for no-op.

## Catálogo de constraints

A migration `src/migrations/Migration20261003120000_persistence.ts` é a fonte da verdade. Todo objeto tem nome explícito, e os testes de schema violam uma regra por vez com SQL direto e afirmam o SQLSTATE **e o nome** da constraint.

**`wallets`**

| Objeto | Definição | Invariante protegida |
| --- | --- | --- |
| `uq_wallets_player_currency` | `UNIQUE (player_id, currency)` | no máximo uma wallet por jogador + moeda, mesmo com criações concorrentes |
| `ck_wallets_balance_non_negative` | `CHECK (balance >= 0)` | saldo nunca negativo — última barreira se o lock ou o domínio falharem |
| `ck_wallets_version_positive` | `CHECK (version >= 1)` | `version` começa em 1 |
| `ck_wallets_currency_iso` | `CHECK (currency ~ '^[A-Z]{3}$')` | moeda ISO-4217; impede `brl` e `BRL` virarem duas wallets |

**`wager_transactions`**

| Objeto | Definição | Invariante protegida |
| --- | --- | --- |
| `uq_wager_tx_provider_external` | `UNIQUE (provider_id, external_transaction_id)` | uma operação do provedor existe uma única vez; é também a chave de resolução de referência |
| `uq_wager_tx_provider_idempotency_key` | `UNIQUE (provider_id, idempotency_key)` | idempotência persistida, com escopo por provedor |
| `uq_wager_tx_id_wallet` | `UNIQUE (id, wallet_id)` | redundante com a PK; existe para ser alvo de `fk_ledger_transaction` |
| `ck_wager_tx_kind` | `CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK'))` | só tipos do domínio |
| `ck_wager_tx_status` | `CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'))` | só estados da máquina de estados |
| `ck_wager_tx_amount_non_negative` | `CHECK (amount >= 0)` | valor nunca negativo (zero é válido para `LOSS`) |
| `ck_wager_tx_currency_iso` | `CHECK (currency ~ '^[A-Z]{3}$')` | moeda ISO |
| `ck_wager_tx_reversal_has_reference` | `CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL)` | reversão sempre aponta para algo |
| `ck_wager_tx_failure_code` | `CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL))` | toda rejeição ou falha tem código; código só existe em rejeição ou falha |
| `ck_wager_tx_processed_at` | `CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL))` | `processed_at` existe se e só se aplicada |
| `ck_wager_tx_completed_at` | `CHECK ((status IN ('PROCESSED','REJECTED','FAILED')) = (completed_at IS NOT NULL))` | estado terminal tem instante; não terminal não tem |
| `ck_wager_tx_result_balance` | `CHECK ((status IN ('PROCESSED','REJECTED')) = (result_balance_amount IS NOT NULL) AND (result_balance_amount IS NULL) = (result_balance_currency IS NULL) AND result_balance_amount >= 0 AND result_balance_currency ~ '^[A-Z]{3}$')` | o replay sempre tem o saldo original a devolver; valor e moeda andam juntos |
| `ck_wager_tx_processed_reversal_resolved` | `CHECK (kind NOT IN ('REFUND','ROLLBACK') OR status <> 'PROCESSED' OR reference_transaction_id IS NOT NULL)` | fecha o buraco de `uq_wager_tx_processed_reversal`: `NULL` não colide em índice único |
| `ck_wager_tx_reference_attempts` | `CHECK (reference_attempts >= 0)` | contador de tentativas coerente |
| `fk_wager_tx_wallet` | `FOREIGN KEY (wallet_id) REFERENCES wallets (id)` | transação sempre pertence a uma wallet existente |
| `fk_wager_tx_reference` | `FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions (id)` | referência resolvida aponta para uma transação real |
| `uq_wager_tx_processed_reversal` | `UNIQUE INDEX (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'` | no máximo **uma** reversão aplicada por referência, de qualquer tipo, mesmo em corrida |
| `uq_wager_tx_opening_per_wallet` | `UNIQUE INDEX (wallet_id) WHERE kind = 'OPENING'` | saldo inicial creditado uma única vez por wallet |
| `ix_wager_tx_pending_reference_due` | `INDEX (next_reference_attempt_at NULLS FIRST) WHERE status = 'PENDING_REFERENCE'` | não é invariante: o worker acha as pendentes vencidas sem varrer a tabela |

**`wallet_ledger_entries`**

| Objeto | Definição | Invariante protegida |
| --- | --- | --- |
| `uq_ledger_transaction_wallet` | `UNIQUE (transaction_id, wallet_id)` | uma transação gera no máximo um lançamento por wallet: retry não duplica débito nem crédito |
| `uq_ledger_wallet_seq` | `UNIQUE (wallet_id, seq)` | ordem total e estável por wallet; serve a paginação por cursor |
| `ck_ledger_direction` | `CHECK (direction IN ('DEBIT','CREDIT'))` | só direções do domínio |
| `ck_ledger_amount_positive` | `CHECK (amount > 0)` | todo lançamento movimenta saldo |
| `ck_ledger_balances_non_negative` | `CHECK (balance_before >= 0 AND balance_after >= 0)` | o histórico nunca registra saldo negativo |
| `ck_ledger_arithmetic` | `CHECK (balance_after = CASE direction WHEN 'CREDIT' THEN balance_before + amount ELSE balance_before - amount END)` | cada lançamento fecha a própria conta |
| `ck_ledger_currency_iso` | `CHECK (currency ~ '^[A-Z]{3}$')` | moeda ISO |
| `fk_ledger_wallet` | `FOREIGN KEY (wallet_id) REFERENCES wallets (id)` | lançamento sempre ligado a uma wallet real |
| `fk_ledger_transaction` | `FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id)` | o lançamento pertence à wallet **da própria transação**: uma FK simples aceitaria debitar a wallet A por uma transação da wallet B |
| `trg_ledger_no_update_delete` | `BEFORE UPDATE OR DELETE ... FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation()` | ledger imutável por qualquer caminho, inclusive SQL manual |
| `trg_ledger_no_truncate` | `BEFORE TRUNCATE ... FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation()` | `TRUNCATE` não dispara trigger de linha; sem este o ledger poderia ser esvaziado |

**`inbox_messages`**

| Objeto | Definição | Invariante protegida |
| --- | --- | --- |
| `pk_inbox_messages` | `PRIMARY KEY (consumer_name, message_id)` | uma mensagem é processada no máximo uma vez por consumidor, mesmo com reentrega em instâncias diferentes |

**`outbox_messages`**

| Objeto | Definição | Invariante protegida |
| --- | --- | --- |
| chave primária `id` | o `id` é o `eventId` | o mesmo evento não é enfileirado duas vezes |
| `ck_outbox_attempts_non_negative` | `CHECK (attempts >= 0)` | contador coerente |
| `ix_outbox_pending` | `INDEX (next_attempt_at NULLS FIRST) WHERE published_at IS NULL` | não é invariante: mantém o claim do publisher barato — o índice só contém o backlog, não o histórico publicado |

Notas:

- **Bicondicionais.** As CHECKs de coerência entre estado e campos usam `=` entre booleanos, mais forte que "rejeitada tem código": também impedem `failure_code` em transação aplicada. Refletem o domínio, onde só `reject`/`fail` gravam o código e só `markProcessed` grava `processed_at`. Numa CHECK, resultado `NULL` conta como aprovado — por isso os termos `>= 0` e `~` de `ck_wager_tx_result_balance` não barram o caso nulo.
- **Trigger, não `REVOKE`.** O dono da tabela (o usuário da aplicação, que roda as migrations) ignora `REVOKE UPDATE, DELETE`; exigiria dois roles no Compose. O trigger vale para qualquer caminho.
- **`seq` e cursor.** `seq` é `bigint GENERATED ALWAYS AS IDENTITY`: a aplicação não consegue informar o valor. Sequences são alocadas fora da ordem de commit **entre** transações concorrentes, mas todo lançamento de uma wallet é gravado com a wallet travada — então, por wallet, a ordem de `seq` é a ordem de commit. O cursor do ledger é `seq > ?` por wallet (opaco na API: `base64url`), e nenhum lançamento "aparece no passado". Um cursor por `created_at` teria empates e dependeria do relógio de cada instância.
- **`NULLS FIRST`** nos dois índices de worker: próxima tentativa nula significa "nunca tentada", que é a mais vencida.
- **Sem FK em inbox e outbox.** `aggregate_id` aponta ora para wallet, ora para transação. São tabelas de transporte: a consistência com o resto vem de estarem na mesma transação SQL.
- **Ids.** Ids internos são `uuid` (UUID v7, ordenado por tempo: os inserts caem no fim do índice da PK). Ids do provedor são `text`: o formato é dele.

## Transactional outbox

### Fluxo

1. O use case grava transação, saldo, ledger e os eventos (`outbox_messages`) na **mesma transação SQL**. Nada é publicado antes do commit.
2. Um worker dentro da aplicação (`OutboxPublisherWorker`) roda lotes em loop. Cada lote (`PublishOutboxBatch`) é uma transação:
   - reivindica as mensagens pendentes e vencidas com `SELECT ... FOR UPDATE SKIP LOCKED`;
   - envia uma a uma, na ordem do claim, para `wagering-events.fifo` (`MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`, corpo = envelope gravado);
   - aceita → `published_at`; falhou → `attempts + 1` e `next_attempt_at` pelo backoff (1s, 2s, 4s… teto de 5 min);
   - commit.

### O lock de linha é o lease

Não existe coluna `locked_by`/`locked_until`. As linhas reivindicadas ficam travadas até o commit do lote; `SKIP LOCKED` faz outro publisher pegar outras linhas em vez de esperar. Se o processo morre, o Postgres desfaz a transação e libera as linhas — sem expiração de lease, sem relógio compartilhado, sem migration. O custo é uma conexão do pool segurada durante o I/O com o SQS, limitado pelo tempo limite de envio.

### Falhas

| Falha no envio | Mensagem | Resto do lote |
| --- | --- | --- |
| **transitória** — SQS indisponível: conexão, tempo limite, 5xx, throttling, fila não resolvida | retry agendado | **interrompido**: as demais ficam intocadas (sem contar tentativa) |
| **não transitória** — o SQS respondeu recusando a mensagem (4xx) | retry agendado | continua, **pulando** as mensagens seguintes do mesmo agregado |

- Interromper na indisponibilidade evita gastar um tempo limite e uma tentativa por mensagem: `attempts` mede problemas do evento, não do SQS. Uma mensagem por lote serve de sonda.
- Nenhum evento é abandonado: não há limite de tentativas. Acima de 5 tentativas, cada nova falha gera um log `warn` com `eventId`, `eventType`, `aggregateId` e `attempts` (nunca o payload).
- O que já foi publicado no lote é confirmado mesmo quando o lote é interrompido.

### Entrega at-least-once

O evento só existe na outbox se a transação financeira deu commit, e só deixa de ser pendente depois que o SQS aceitou **e** o `published_at` deu commit. Um crash em qualquer ponto entre os dois deixa a mensagem pendente, e algum publisher a reivindica de novo:

- **crash depois do commit e antes de publicar** → a linha está pendente; outra instância publica;
- **crash depois de publicar e antes de marcar** → a transação do lote é desfeita; a mensagem é enviada de novo.

### Por que a duplicata é segura

O reenvio sai da mesma linha da outbox: mesmo `eventId`, mesmo corpo. Duas barreiras:

1. `MessageDeduplicationId = eventId`: dentro de 5 minutos o SQS FIFO aceita o reenvio e não entrega outra cópia.
2. Fora dessa janela (retry com backoff longo) o consumidor recebe duas vezes e **deve deduplicar por `eventId`**, que é estável e está no envelope. Esse é o contrato; a barreira 1 é só otimização — a consistência não depende apenas do FIFO.

### Ordenação: garantida no lote, não entre lotes

`MessageGroupId = aggregateId` preserva, na entrega, a ordem em que as mensagens chegaram ao SQS — mas não garante que cheguem na ordem de `occurredAt`. Dois eventos do mesmo agregado podem ser publicados invertidos quando:

- dois publishers reivindicam cada um um deles e o do mais novo envia primeiro;
- o mais antigo falha, entra em backoff, e o mais novo é publicado em um **lote posterior** (mensagens novas têm prioridade sobre as em retry, para um evento problemático não segurar a fila).

Dentro de um mesmo lote a inversão não acontece: o envio é sequencial por `occurredAt`, um agregado que falhou é pulado até o fim do lote, e a indisponibilidade do SQS interrompe o lote inteiro.

O que mitiga o que resta:

- eventos do mesmo agregado costumam nascer na mesma transação (mesmo lote) ou distantes no tempo (`PendingReference` → `Processed`);
- `WalletBalanceChanged` carrega `walletVersion`, monotônica por wallet: o consumidor detecta e descarta ou reordena um evento atrasado; os demais carregam `occurredAt`;
- ligar o publisher em uma única instância (`OUTBOX_PUBLISHER_ENABLED`) elimina o primeiro caso, ao custo de failover manual.

Ordenação estrita exigiria serializar por agregado (bloquear os eventos mais novos enquanto houver um mais antigo pendente). Não foi implementado: troca disponibilidade por ordem, e um evento problemático passaria a segurar todos os seguintes do agregado.

## Consumidor da fila

Fila `wager-transactions.fifo`, DLQ `wager-transactions-dlq.fifo`.

### Fluxo

1. `SqsWagerConsumer` (adapter) recebe em long polling até `SQS_CONSUMER_BATCH_SIZE` mensagens e entrega o corpo de cada uma ao `ProcessWagerMessage` (use case).
2. `ProcessWagerMessage` valida o envelope (`type = WagerTransactionRequested`, `messageId`, `occurredAt`, `data`) e, em **uma transação**:
   - consulta a inbox por `(wager-transactions, messageId)` — se já existe, é duplicata;
   - chama o **mesmo** `ProcessWagerTransaction` da HTTP com `data` (a chave de idempotência vem de `data.idempotencyKey`; `correlationId = causationId = messageId`);
   - grava a inbox, já marcada como processada.
3. Só depois do commit o adapter apaga a mensagem (`DeleteMessage`).

### Inbox e efeito financeiro no mesmo commit

`ProcessWagerTransaction` abre a própria transação (`TransactionRunner.run`) e não foi alterado para a fila. Como `run` é reentrante (ver [Estratégia transacional](#estratégia-transacional)), dentro do `run` do `ProcessWagerMessage` ele vira um savepoint: a transação externa cobre inbox, transação financeira, ledger, wallet e outbox com um único commit.

Consequências:

- a releitura que o use case faz depois de uma violação de idempotência continua funcionando: a violação desfaz só o savepoint, e a transação externa segue utilizável;
- a inbox é gravada **por último**, e só quando há transação gravada (aplicada, rejeitada, pendente ou replay). Mensagem que vai para a DLQ não deixa registro: se o envio à DLQ falhar, a reentrega não pode ser tomada por duplicata;
- duas instâncias com a mesma mensagem: o lock da wallet as serializa, a segunda vê o replay, tenta gravar a inbox e viola `pk_inbox_messages` — tudo que ela fez é desfeito e a mensagem é tratada como duplicata. A PK é a garantia; a consulta inicial é só o caminho barato.

A correção não depende do FIFO: a inbox deduplica a mensagem, a idempotência por `(providerId, idempotencyKey)` deduplica a operação entre canais (HTTP e fila), e o lock da wallet serializa o saldo.

### Classificação

| Resultado | Ação | Log |
| --- | --- | --- |
| aplicada, rejeitada por regra de negócio, pendente de referência, replay, duplicata | `DeleteMessage` depois do commit | `log` |
| **permanente** — envelope inválido, payload inválido (inclui `OPENING`), wallet inexistente, conflito de idempotência | `SendMessage` na `wager-transactions-dlq.fifo` com o atributo `reason`, depois `DeleteMessage` | `warn` |
| **transitório** — banco fora, lock timeout, deadlock, pool esgotado (`isTransientInfraError`) | não apaga; `ChangeMessageVisibility` com backoff | `warn` |
| erro inesperado | igual ao transitório: na dúvida, não descartar | `error` |

`reason` na DLQ: `INVALID_ENVELOPE`, `INVALID_PAYLOAD`, `WALLET_NOT_FOUND`, `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT`. Mensagem na DLQ **sem** `reason` chegou pelo redrive (esgotou as tentativas).

Rejeição de negócio não é falha de consumo: a transação `REJECTED` é um resultado gravado, com evento na outbox.

Falha no `DeleteMessage` depois do commit só gera log: a mensagem reaparece e a inbox a reconhece. É o mesmo caminho do worker morto entre o commit e o ack.

### Retry e `maxReceiveCount = 8`

O adiamento é `min(backoff(ApproximateReceiveCount), SQS_CONSUMER_MAX_BACKOFF_SECONDS)`: 1, 2, 4, 8, 16, 32, 64 e 128 s depois dos recebimentos 1 a 8. No 9º recebimento o próprio SQS move a mensagem para a DLQ (política de redrive definida em `docker/localstack/init-queues.sh`). Isso tolera cerca de **4 minutos** de indisponibilidade do banco antes de uma mensagem válida ir para a DLQ; com 5 seriam ~30 s, e um restart do Postgres despejaria a fila. O consumidor não conta tentativas: quem aplica o limite é a fila.

### Paralelismo e ordem

- O lote é a unidade de paralelismo: no máximo `SQS_CONSUMER_BATCH_SIZE` (1–10) mensagens em andamento por instância.
- Grupos FIFO diferentes rodam em paralelo; mensagens do **mesmo grupo** no lote rodam em série, na ordem de entrega — senão um `REFUND` ultrapassaria a `BET` e viraria `PENDING_REFERENCE` à toa.
- Se uma mensagem falha, as seguintes do grupo não são iniciadas e voltam com **o mesmo adiamento** dela, para serem entregues de novo na ordem.
- **Margem de visibilidade**: antes de iniciar cada mensagem, o consumidor confere o tempo desde o receive. Se faltar menos que `DB_LOCK_TIMEOUT_MS + 5 s` para o fim da visibilidade, a mensagem e as restantes do grupo são devolvidas (`ChangeMessageVisibility 0`) sem iniciar — outra instância não recebe uma mensagem que esta ainda processaria. A configuração é recusada se `SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS` não exceder essa margem.

### Encerramento

Em `SIGTERM` o consumidor para de abrir novos receives, conclui (commit + ack) as mensagens em andamento e devolve com `ChangeMessageVisibility 0` as recebidas e não iniciadas. O encerramento espera a resposta do long polling em curso (no máximo `SQS_CONSUMER_WAIT_TIME_SECONDS`) e devolve o que vier.

### Desvios por fidelidade do LocalStack

Dois comportamentos do consumidor existem porque o broker local não se comportou como o esperado durante a implementação. Em ambos a regra ficou mais conservadora, sem depender do broker:

- **O resto do grupo volta com o mesmo adiamento da mensagem que falhou**, e não com 0. Devolver com 0 dependeria de o broker bloquear o grupo enquanto a primeira está invisível; o LocalStack não bloqueou (entregou o `REFUND` antes da `BET` em backoff). Com o mesmo adiamento, a que falhou fica visível primeiro e o FIFO entrega as duas na ordem.
- **O long polling em curso não é abortado no encerramento.** Um receive abandonado pelo cliente continua valendo no broker, e a mensagem que chegar nele fica invisível até a visibilidade vencer — com o LocalStack, mensagens ficavam presas por 30 s logo depois de um consumidor fechar. Esperar a resposta custa até `SQS_CONSUMER_WAIT_TIME_SECONDS` a mais no encerramento e garante que tudo que foi recebido é devolvido.

## Worker de `PENDING_REFERENCE`

Uma transação cuja referência ainda não chegou é gravada como `PENDING_REFERENCE` pela submissão. Quem a leva a um estado terminal é este worker (`PendingReferenceWorker` → `ReprocessPendingReferences`).

### Fluxo

1. Seleção do lote, **sem lock e fora de transação**: `status = 'PENDING_REFERENCE'` e `next_reference_attempt_at` nulo ou vencido, pela ordem do índice parcial `ix_wager_tx_pending_reference_due`. Só id e wallet.
2. Para cada candidata, uma transação própria:
   - `SELECT ... FOR UPDATE` na wallet;
   - relê a transação com `FOR UPDATE SKIP LOCKED` **e** o mesmo filtro de estado e vencimento. Sem linha → ignora;
   - aplica as mesmas regras da submissão (`WagerDecision`, ponto único usado pelos dois caminhos);
   - grava com `UPDATE ... WHERE id = ? AND status = 'PENDING_REFERENCE'`, exigindo exatamente uma linha; depois lançamento, wallet e eventos na outbox, tudo no mesmo commit.

| Situação da referência | Desfecho |
| --- | --- |
| `PROCESSED` e válida | `PROCESSED` + lançamento + `WagerTransactionProcessed` e `WalletBalanceChanged` |
| viola uma regra (rejeitada, já revertida, valor/tipo/identidade diferentes) | `REJECTED` com o código da regra + `WagerTransactionRejected` |
| aplicação deixaria saldo negativo | `REJECTED` com `REVERSAL_INSUFFICIENT_FUNDS` |
| ausente ou não finalizada, dentro do prazo | continua pendente: `reference_attempts + 1`, próxima tentativa pelo backoff (1s, 2s, 4s… teto de 5 min). Sem evento |
| ausente ou não finalizada, prazo esgotado | `REJECTED` com `REFERENCE_NOT_FOUND`, saldo observado = saldo atual |

A ordem de lock e a ausência de deadlock estão em [Concorrência](#concorrência). O `UPDATE` condicionado ao estado é a rede de segurança se essa ordem for quebrada por código futuro. Uma exceção em uma candidata (ex.: `lock_timeout` na wallet) desfaz só a transação dela; o lote segue e ela continua vencida.

### Prazo: 15 minutos a partir do `createdAt`

`PENDING_REFERENCE_TTL_SECONDS` (padrão 900). É um prazo, e não um número de tentativas, porque o que importa ao provedor é em quanto tempo ele recebe a resposta definitiva. A inversão de ordem típica se resolve em segundos; o pior caso legítimo é a referência presa no retry do consumidor SQS, cujo adiamento tem teto de 5 min — 15 min cobrem algumas reentregas. Acima disso a referência provavelmente nunca existiu.

- A próxima tentativa nunca é agendada para depois do prazo (`min(agora + backoff, createdAt + ttl)`): a rejeição sai no prazo, não até 5 min depois.
- O prazo só é avaliado quando a decisão continua "aguardar". Se a referência já pode ser avaliada, vale a regra, mesmo depois do prazo.
- `REFERENCE_NOT_FOUND` significa **referência não resolvida no prazo**: cobre também a referência que existe mas ainda está pendente (cadeia `ROLLBACK → REFUND → BET` em que a `BET` nunca chega e o `ROLLBACK` é o mais antigo).

### Antecipação

Sempre que uma transação fica terminal — na submissão ou no worker — o mesmo commit torna vencidas (`next_reference_attempt_at = agora`) as pendentes do mesmo provider que a referenciam. Sem isso um `REFUND` na 8ª tentativa esperaria ~2 min depois de a `BET` chegar. A submissão **não** resolve a pendente: só a acorda.

Pendentes de wallets diferentes aguardando uma à outra não existem — a segunda a chegar encontra a primeira e é rejeitada por `REFERENCE_MISMATCH` na entrada.

### Eventos

Os eventos gravados pelo worker têm `correlationId` = id da transação (o `correlationId` da submissão original não é persistido) e não têm `causationId`. O id da transação os liga ao `WagerTransactionPendingReference` original (mesmo `aggregateId`).

## Reconciliação

`POST /wallets/:walletId/reconciliation`.

### O que é verificado

`ReconcileWallet` percorre os lançamentos da wallet em ordem de `seq` e, com `Money` (nunca `number`), confere duas coisas independentes:

- **soma**: `calculatedBalance = Σ CREDIT − Σ DEBIT`; `difference = storedBalance − calculatedBalance` (pode ser negativa);
- **corrente**: o primeiro lançamento parte de zero, o `balanceBefore` de cada um é o `balanceAfter` do anterior, e o último `balanceAfter` é o saldo armazenado.

`consistent` só é `true` com diferença zero **e** corrente íntegra. A resposta traz `chainIntact` além dos campos do enunciado: sem ele, uma corrente quebrada com a soma preservada responderia `consistent: false` com `difference: 0.00`, sem explicação. A aritmética de cada lançamento (`before ± amount = after`) já é garantida pelo banco (`ck_ledger_arithmetic`); a continuidade **entre** lançamentos não tem constraint — é o que a reconciliação acrescenta.

### Foto consistente, sem lock

A leitura roda em `TransactionRunner.snapshot`: transação `REPEATABLE READ READ ONLY`. No PostgreSQL isso é snapshot isolation — todas as consultas enxergam o banco no instante da primeira. Como saldo e lançamento são confirmados no mesmo commit, a foto contém os dois ou nenhum: apostas concorrentes na mesma wallet nunca produzem divergência falsa (coberto por teste com reconciliações em laço durante 60 apostas). Leitura simples não pede lock de linha, então a reconciliação não espera o `FOR UPDATE` de ninguém e ninguém espera por ela. Transação somente leitura em REPEATABLE READ não sofre falha de serialização: não há retry.

Alternativas descartadas:

- `FOR UPDATE`/`FOR SHARE` na wallet: consistente, mas disputaria o lock da hot wallet com as apostas;
- duas consultas sem transação (READ COMMITTED): uma aposta confirmada entre elas viraria divergência falsa;
- uma única instrução SQL com a soma e `lag()`: também é uma foto, mas move a aritmética para fora do `Money` ou carrega o ledger inteiro de uma vez. O snapshot reutiliza `findById` e `listByWallet` em páginas de 1000, com memória constante.

### Divergência nunca é corrigida

O use case não recebe nenhuma dependência de escrita e roda em transação somente leitura — o banco recusaria um UPDATE ali. Divergência gera: `consistent: false` na resposta, um log de nível `error` (`walletId`, `balanceMatches`, `chainIntact`, `checkedEntries`, `firstBrokenEntryId` — sem saldos nem a diferença, que estão na resposta) e `wagering_reconciliation_divergences_total`. Corrigir é decisão humana: saldo errado e ledger errado pedem ações diferentes.

## Observabilidade

### Logs e correlação

Os logs são JSON, uma linha por entrada (erros em stderr, com o stack em um campo), com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` no primeiro nível quando conhecidos.

- **Contexto implícito**: `src/observability/log-context.ts` guarda os ids em `AsyncLocalStorage` — o mesmo mecanismo com que o MikroORM propaga a transação corrente. O logger (`src/logger.ts`) os acrescenta a toda linha; quem loga não repassa ids. Domínio e aplicação não logam nem conhecem o contexto: o `correlationId` dos eventos continua entrando por `RequestContext`.
- **Formato**: o `ConsoleLogger` do Nest aninharia um objeto logado dentro de `message`; a subclasse leva os campos ao primeiro nível e mantém `message` como texto.

| Canal | `correlationId` | Onde o contexto abre |
| --- | --- | --- |
| HTTP | header `X-Correlation-Id` se válido (1–128 de `[A-Za-z0-9_.:-]`), senão UUID gerado; devolvido em toda resposta | middleware no `AppModule`; um log de acesso por requisição (`debug` para `/health` e `/metrics`) |
| Fila | `messageId` do envelope | `SqsWagerConsumer`, por mensagem |
| Worker de pendentes | id da transação (o mesmo dos eventos que ele grava) | por candidata |
| Publicador da outbox | o `correlationId` gravado no envelope do evento | campo do log de falha |

O valor do header é validado porque atravessa uma fronteira de confiança e vai parar em logs, eventos e na resposta.

**Nunca é logado**: corpo de requisição ou de mensagem, payload de evento, valores de transação, saldos e a diferença de reconciliação. Um teste sobe o processo real, exercita HTTP, fila, worker e reconciliação divergente, e procura os valores usados em tudo que o processo escreveu.

### Health checks

`/health/live` não consulta dependência nenhuma: responde enquanto o processo estiver vivo. `/health/ready` executa em paralelo `SELECT 1` e `GetQueueUrl` da fila principal, cada um com tempo limite de 2 s, e responde `503` se algum falhar. O ORM é configurado com `connect: false`: com o padrão, o Postgres fora derrubaria o boot e o processo não chegaria a reportar `postgres: down`. O motivo da falha vai para o log, nunca para o corpo.

### Métricas (`GET /metrics`)

Formato Prometheus, sem autenticação (como o health: nenhuma série carrega dado de jogador; em produção, restringir por rede).

| Métrica | Tipo | Labels | Significado |
| --- | --- | --- | --- |
| `wagering_transactions_total` | counter | `kind`, `status`, `channel` | transação com desfecho gravado (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`); replay não conta; conclusão de pendente conta com `channel="worker"` |
| `wagering_duplicates_total` | counter | `type`, `channel` | `idempotent_replay` (mesma chave e payload) ou `inbox_duplicate` (mensagem reentregue) |
| `wagering_retries_total` | counter | `source` | `outbox` (publicação reagendada), `sqs_consumer` (mensagem devolvida para reentrega), `pending_reference` (referência ainda ausente) |
| `wagering_dlq_messages_total` | counter | `reason` | mensagens que **o consumidor desta instância** enviou à DLQ |
| `wagering_dlq_depth` | gauge | — | mensagens na DLQ **segundo o SQS**, no momento do scrape |
| `wagering_lock_conflicts_total` | counter | `type` | `lock_timeout`, `deadlock`, `unique_violation` (corrida de idempotência ou de inbox decidida pela constraint) |
| `wagering_outbox_oldest_pending_age_seconds` | gauge | — | idade do evento não publicado mais antigo, lida do banco no scrape |
| `wagering_outbox_publish_lag_seconds` | histogram | — | `occurredAt → publishedAt` a cada publicação |
| `wagering_processing_duration_seconds` | histogram | `channel` | tempo de cada submissão HTTP, mensagem consumida ou pendente reavaliada |
| `wagering_reconciliation_divergences_total` | counter | — | reconciliações com `consistent: false` |

Decisões:

- **`prom-client`** (dependência nova): o formato de exposição — escape de labels, `_bucket`/`_sum`/`_count`, `+Inf` — é um contrato com o scraper; a biblioteca de referência custa menos que ~80 linhas próprias com teste. Só as classes em JavaScript puro são usadas (sem `collectDefaultMetrics`, que depende de APIs que o Bun não implementa por completo), com um `Registry` por instância da aplicação em vez do global.
- **Use cases devolvem fatos; adapters contam.** Não existe porta de métricas: controllers, consumidor e workers incrementam a partir dos resultados dos use cases. A exceção é `wagering_lock_conflicts_total`, contada no `MikroOrmTransactionRunner` — o único ponto por onde passam lock timeout, deadlock e a releitura por unicidade — uma vez por transação abortada (o `run` aninhado vê o mesmo erro duas vezes). Wallet duplicada não conta: é conflito de negócio.
- **Labels só de conjuntos fechados do código.** Nenhum valor vindo do payload vira label — nem `providerId`. Um teste afirma que nenhum id ou valor usado aparece em `/metrics`.
- **Contadores são por instância e zeram no restart.** Isso não fere a regra de "nada em memória para idempotência": são telemetria, nenhuma decisão depende deles. Cada instância deve ser alvo de scrape.
- **Os dois gauges leem estado externo a cada scrape**, porque um valor em memória estaria errado com várias instâncias: a idade da outbox vem do banco e a profundidade da DLQ vem do SQS (`GetQueueAttributes`, tempo limite de 1 s). Se a dependência falhar, a série reporta `NaN` e `/metrics` responde `200` com o resto — métricas não podem cair junto com o que elas monitoram.

### `wagering_dlq_messages_total` × `wagering_dlq_depth`

Há dois caminhos para a DLQ (ver "Classificação" e "Retry" em [Consumidor da fila](#consumidor-da-fila)), e o contador só enxerga um:

| | `wagering_dlq_messages_total{reason}` | `wagering_dlq_depth` |
| --- | --- | --- |
| Fonte | o consumidor, ao classificar um erro permanente | o broker |
| Inclui o redrive (`maxReceiveCount` esgotado) | **não** — o SQS move a mensagem sem passar pelo código | sim |
| Responde | por quê e a que taxa, por instância | quanto há parado agora |
| Diminui | nunca (zera no restart) | quando alguém drena a DLQ |

Profundidade crescendo sem o contador crescer significa mensagens morrendo por retry esgotado — indisponibilidade prolongada ou bug —, não por classificação. O valor é aproximado (`ApproximateNumberOfMessages`) e igual em todas as instâncias: em alerta, usar `max`.

## Autenticação

**Não implementada.** O enunciado (§2) diz que autenticação não pontua e não deve competir com correção financeira, concorrência e idempotência, e aceita a ausência desde que a decisão seja documentada, o desenho descrito e o ponto de extensão fique explícito no código. O tempo foi para correção financeira, concorrência, idempotência e mensageria.

### Ponto de extensão

`AuthGuard` (`src/http/auth.guard.ts`) é um `CanActivate` que devolve `true`. Ele é aplicado com `@UseGuards(AuthGuard)` **por controller** (`WalletsController` e `WageringController`), e não como guard global: assim `/health` e `/metrics` ficam de fora por construção, não por uma lista de exceções. Um teste substitui o guard por um que nega tudo e afirma que os sete endpoints de negócio respondem `403` no envelope de erro e nada é gravado, enquanto `/health/live`, `/health/ready` e `/metrics` continuam respondendo `200`.

### Desenho que seria adotado

IdP externo — **Keycloak**, no mesmo Compose — sem tabela própria de usuários:

1. Cada provedor é um client confidencial e obtém o token por **client credentials** (comunicação máquina a máquina, sem usuário final).
2. O guard valida o JWT do header `Authorization: Bearer` contra as chaves públicas do IdP (**JWKS**, com cache): assinatura, `iss`, `aud` e `exp`. Não há chamada ao IdP por requisição.
3. Uma claim do token identifica o provedor. O guard a compara com o `providerId` do corpo (`POST /wagering/transactions`) ou da rota (`GET /providers/:providerId/...`): um provedor não submete nem consulta transações de outro.
4. Token ausente ou inválido → `401 UNAUTHORIZED`; token válido de outro provedor → `403 FORBIDDEN`. Os dois códigos já estão mapeados no envelope de erro.
5. Wallets, ledger e reconciliação são operações internas: exigiriam um papel de operador (role no token), não a identidade de um provedor.

A mudança ficaria contida no corpo do guard (mais a configuração do emissor); controllers e use cases não mudam.

### Fila

Mensagens de `wager-transactions.fifo` são tratadas como **canal interno confiável**, como define o enunciado: não há token a validar. O `providerId` dentro da mensagem continua sujeito às mesmas validações de domínio da HTTP, porque o use case é o mesmo.

## Interpretações adotadas do enunciado

| Regra do enunciado | Interpretação | Por quê | Onde |
| --- | --- | --- | --- |
| §7 regra 4 — a referência não pode ser revertida duas vezes "pelo mesmo tipo de operação" | no máximo **uma** reversão aplicada por referência, de qualquer tipo | a leitura literal permitiria `REFUND` + `ROLLBACK` da mesma `BET`, creditando a aposta duas vezes | `src/domain/reference-validation.ts`, `uq_wager_tx_processed_reversal` |
| §7.1 — `failureCode` que identifique "a referência inexistente" | `REFERENCE_NOT_FOUND` = referência **não resolvida no prazo**, inclusive a que existe e continua pendente | numa cadeia `ROLLBACK → REFUND → BET` sem a `BET`, o `ROLLBACK` também precisa terminar | `src/application/reprocess-pending-references.ts` |
| §7.1 — limite de tentativas **ou** TTL | TTL de 15 min a partir do `createdAt`, avaliado só quando a decisão ainda é "aguardar" | ver [Worker de PENDING_REFERENCE](#worker-de-pending_reference) | `src/application/reprocess-pending-references.ts`, `src/config.ts` |
| §9 — distinguir payload inválido de rejeição de negócio | `playerId` que não é o dono da wallet é **rejeição** (`WALLET_PLAYER_MISMATCH`, `422`), não `400` | o payload é bem formado; a regra violada é de negócio, e a tentativa fica auditável | `src/application/wager-decision.ts` |
| §6.1 — rejeitar "mais de 2 casas decimais" | a entrada aceita 0, 1 ou 2 casas (`"25"`, `"25.5"`); a saída tem sempre 2 | o enunciado só manda rejeitar acima de 2; exigir exatamente 2 seria mais rígido que ele | `src/domain/money.ts` |
| §7 — `LOSS` "registra o resultado sem mover saldo" | `LOSS` aceita valor zero; os demais tipos exigem valor > 0 | uma perda não precisa carregar valor; os outros tipos geram lançamento, que exige valor positivo | `src/domain/wager-transaction.ts` |
| §7 — `WIN` "pode referenciar a `BET` da mesma rodada" | a referência é opcional em `WIN` e `LOSS`; se informada, deve ser uma `BET` da mesma identidade, e a transação aguarda como `PENDING_REFERENCE` se ela ainda não chegou. Valor igual e reversão anterior não são exigidos | referência informada e errada deve ser recusada; `WIN` não reverte a `BET` | `src/domain/reference-validation.ts` |
| §9 — default recomendado da chave `{providerId}:{externalTransactionId}` | o mesmo `externalTransactionId` com **outra** chave é conflito (`409`), não uma segunda transação | uma operação do provedor existe uma única vez | `src/application/process-wager-transaction.ts` |
| §10 — erros permanentes vão para a DLQ | wallet inexistente na fila é **permanente** (DLQ com `reason = WALLET_NOT_FOUND`); a mensagem não espera a wallet ser criada | não há prazo razoável para esperar; o `reason` permite reenviar seletivamente | `src/application/process-wager-message.ts` |
| §10 — envelope com `occurredAt` | é validado e não usado: o instante da transação é o do relógio do servidor, como na HTTP | um instante informado pelo remetente não deve ordenar o ledger | `src/application/process-wager-message.ts` |
| §6.2 — `version` inicia em 1 "após a criação" | a wallet criada com saldo inicial já nasce com `version: 1`, e o crédito de abertura não a incrementa | é a resposta de exemplo do §9 (`1000.00`, `version: 1`) | `src/domain/wallet.ts` |
| §6.3 — assinaturas de `markProcessed` e `reject` | recebem também o saldo observado e o instante | §7 regra 7 exige devolver no replay o saldo daquele momento, e o esqueleto não tem onde guardá-lo | `src/domain/wager-transaction.ts` |
| §9 — resposta da reconciliação | campo adicional `chainIntact` | ver [Reconciliação](#reconciliação) | `src/application/reconcile-wallet.ts` |
| §6.3 — `OPENING` é interno | além do `kind`, o `providerId` `internal` é reservado e recusado em entrada externa | sem isso um provedor poderia colidir com a transação de abertura | `src/domain/wager-transaction.ts` |

## Testes obrigatórios (§13)

Os testes de integração e de concorrência usam o PostgreSQL e o LocalStack do Compose, sem mocks; os que precisam de falha a criam por fora (lock real segurado por outra conexão, banco em porta fechada, proxy de rede) ou embrulham o adapter real. Os testes de processo sobem `bun src/main.ts` de verdade (`test/process.ts`) e usam sinais reais.

A invariante final `wallet.balance == saldo reconstruído pelo ledger` é afirmada por um helper único, `expectLedgerInvariant` (`test/application/helpers.ts`), que compara o saldo armazenado com `Σ CREDIT − Σ DEBIT` **e** com o `balance_after` do último lançamento. Ele é chamado nos testes de integração que movimentam saldo; no domínio, o equivalente é `saldo sempre igual ao reconstruído pelos lançamentos` (`test/domain/wallet.test.ts`).

**Unidade**

| Exigência | Onde |
| --- | --- |
| `Money`: operações e validações | `test/domain/money.test.ts` (`entrada`, `serialização`, `aritmética`, `comparação`) |
| invariantes da `Wallet` | `test/domain/wallet.test.ts` (`invariantes`), `test/domain/ledger-entry.test.ts` |
| regras de `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` | `test/domain/wagering-rules.test.ts`, `test/domain/reference-validation.test.ts`, `test/domain/wager-transaction.test.ts` |
| conflito de moeda | `test/domain/money.test.ts` (`conflito de moeda`), `test/domain/wallet.test.ts` (`conflito de moeda não altera a wallet`), `test/domain/wagering-rules.test.ts` |
| idempotency key com payload divergente | `test/domain/payload-hash.test.ts` (`idempotency key com payload divergente`) |

**Integração**

| Exigência | Onde |
| --- | --- |
| migrations e constraints | `test/migrations.integration.test.ts` (up → down → up), `test/persistence/schema.integration.test.ts` (cada constraint, índice e trigger) |
| atomicidade entre wallet, ledger, inbox e outbox | `test/persistence/repositories.integration.test.ts` (`persistência atômica`), `test/application/process-wager.integration.test.ts` (`atomicidade`), `test/consumer/process-wager-message.integration.test.ts` (`falha ao gravar a inbox desfaz a transação financeira, o lançamento e os eventos`) |
| inbox e redelivery | `test/consumer/process-wager-message.integration.test.ts` (`mesma mensagem duas vezes`, `a mesma mensagem 20 vezes em paralelo`), `test/consumer/consumer.integration.test.ts` (`mesma mensagem entregue duas vezes`, `duas instâncias com a mesma mensagem`) |
| publishers concorrentes sobre a mesma outbox | `test/outbox/publish-outbox-batch.integration.test.ts` (`publishers concorrentes`) |
| retry e DLQ | `test/consumer/consumer.integration.test.ts` (`erro transitório (banco inacessível)`, `excesso de recebimentos`, `erros permanentes vão para a DLQ`), `test/outbox/publish-outbox-batch.integration.test.ts` (`SQS indisponível interrompe o lote`) |
| recuperação após reinicialização | `test/outbox/worker.integration.test.ts` (`crash depois do commit e antes de publicar: outra instância publica`), `test/restart.integration.test.ts` |

**Concorrência**

| # | Exigência | Onde |
| --- | --- | --- |
| 1 | a mesma aposta 50 vezes em paralelo | `test/application/concurrency.integration.test.ts` (`mesma BET 50 vezes em paralelo`), `test/http/api.integration.test.ts` (`mesma BET 50 vezes em paralelo por HTTP`) |
| 2 | disputa de saldo (cenário do §8) | `test/application/concurrency.integration.test.ts` (`seção 8: saldo 100.00, duas BET de 80.00 em paralelo`, `apostas concorrentes além do saldo`) |
| 3 | wallets distintas em paralelo | `test/application/concurrency.integration.test.ts` (`wallets distintas em paralelo não interferem entre si`), `test/persistence/repositories.integration.test.ts` (`wallets diferentes não se bloqueiam`) |
| 4 | ≥ 3 processos simultâneos | `test/consumer/processes.integration.test.ts` (`três instâncias na mesma fila, apostas concorrentes na mesma wallet`) — três processos reais |
| 5 | worker morto depois do commit e antes do ack | `test/consumer/processes.integration.test.ts` (`worker morto depois do commit e antes do ack`) — `SIGKILL` com o `DeleteMessage` preso em um proxy |
| 6 | dois publishers sobre a mesma outbox | `test/outbox/publish-outbox-batch.integration.test.ts` (`dois publishers sobre a mesma outbox`) |
| 7 | `ROLLBACK` ou `REFUND` antes da referência | `test/pending-reference/reprocess.integration.test.ts` (`REFUND chega antes da BET`, `ROLLBACK de WIN chega antes do WIN`), `test/application/process-wager.integration.test.ts` (`referência ausente`) |
| 8 | reinício do serviço com comprovação da consistência final | `test/restart.integration.test.ts` (`reinício do serviço: SIGKILL no meio de carga mista (HTTP e fila), nova instância assume e o estado final é consistente`) |

O item 8 tem teste dedicado: um processo real recebe 232 operações em 4 wallets (por HTTP e pela fila, com reversões aceitas antes da referência), é morto com `SIGKILL` no meio da carga, e um segundo processo assume. O teste afirma que todas as operações terminaram `PROCESSED` uma única vez, o saldo exato de cada wallet, a invariante do ledger, um lançamento por transação, uma linha de inbox por mensagem, DLQ vazia, a reconciliação pela API e que todo evento confirmado foi publicado.

## Limitações conhecidas e o que faria com mais tempo

### Não implementado

- **Autenticação** — só o ponto de extensão (ver [Autenticação](#autenticação)).
- **Teste de carga** (`bun run test:load`) — diferencial opcional; não há números de throughput nem de latência.
- **Aplicação no Compose** — o Compose sobe só Postgres e LocalStack. Várias instâncias são vários processos `bun run start` em portas diferentes; não há `Dockerfile`.
- **Reprocessamento da DLQ** — é operação manual; o atributo `reason` permite reenviar seletivamente.
- **Varredura agendada de reconciliação** — a reconciliação é sob demanda, por wallet.
- **Ordenação estrita da outbox** — ver [Transactional outbox](#transactional-outbox).
- OpenTelemetry, dashboard e ledger de partidas dobradas (opcionais do enunciado).

### API e concorrência

- Uma wallet muito quente pode gerar `503` quando a espera pelo lock passa de `DB_LOCK_TIMEOUT_MS`. O reenvio é seguro, mas não há retry dentro do servidor.
### Consumidor da fila

- **Sem extensão de visibilidade (heartbeat)**: uma mensagem que demore mais que a visibilidade é entregue a outra instância. Não duplica efeito (lock + inbox), só desperdiça um processamento.
- Devolver o resto do grupo consome um recebimento de cada mensagem devolvida; no pior caso ela vai para a DLQ junto com a que estava na frente.
- Indisponibilidade do banco acima de ~4 min manda mensagens válidas para a DLQ.
- Wallet inexistente é erro permanente: a mensagem não espera a wallet ser criada.
- O lote é a unidade de paralelismo: uma mensagem lenta segura o próximo receive daquela instância (`ponytail:` em `sqs-wager-consumer.ts`; trocar por pool deslizante se o throughput pedir).
- O encerramento pode esperar até `SQS_CONSUMER_WAIT_TIME_SECONDS` pelo long polling em curso.
- A inbox grava o hash do corpo da mensagem, mas não o compara: um `messageId` repetido com corpo diferente é tratado como duplicata.

### Outbox

- Dois eventos do mesmo agregado podem ser publicados fora de ordem entre lotes.
- Não há limite de tentativas: um evento que o SQS sempre recusa fica em retry para sempre, com `warn` a cada falha.
- Backoff sem jitter (`ponytail:` em `backoff.ts`): publishers podem sincronizar retries.
- Uma conexão do pool fica segurada durante o envio do lote ao SQS.

### Worker de `PENDING_REFERENCE`

- Candidatas rodam em série, e dois workers podem selecionar o mesmo lote — o segundo só espera a wallet e ignora (`ponytail:` em `reprocess-pending-references.ts`; paralelizar por wallet se o volume de pendentes crescer).
- A antecipação filtra pelo índice parcial das pendentes, sem índice por referência (`ponytail:` em `repositories.ts`).
- Com o worker desligado em todas as instâncias, pendentes não são resolvidas nem expiram.
- O loop de polling é quase igual ao do publisher da outbox (`ponytail:` em `pending-reference.worker.ts`; extrair uma base comum se aparecer um terceiro).
- O `correlationId` da submissão original não é persistido: os eventos de resolução usam o id da transação.

### Reconciliação

- Custo O(lançamentos) por chamada, com a foto aberta durante a leitura — atrasa o VACUUM, não bloqueia escrita (`ponytail:` em `reconcile-wallet.ts`; checkpoint de saldo verificado até um `seq` se o ledger por wallet crescer).

### Observabilidade e schema

- Contadores são por instância e zeram no restart; `/metrics` não tem autenticação.
- O trigger de imutabilidade pode ser desligado por quem tem DDL (`ALTER TABLE ... DISABLE TRIGGER`): fora do modelo de ameaça.
- SQL da migration e `EntitySchema` são mantidos em dois lugares; os testes de round-trip pegam a divergência.

### Com mais tempo, nesta ordem

1. Autenticação com Keycloak no Compose, conforme o desenho acima.
2. Aplicação no Compose (três réplicas) e teste de carga com throughput, p50/p95/p99, taxa de erro, conflitos de lock e outbox lag.
3. Heartbeat de visibilidade e pool deslizante no consumidor.
4. Ferramenta de reprocessamento da DLQ por `reason`.
5. Varredura agendada de reconciliação, com checkpoint por wallet.
6. Jitter no backoff e ordenação estrita opcional por agregado na outbox.
