# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas por HTTP e por SQS, com saldo e ledger consistentes sob concorrência, duplicidade e entrega fora de ordem.

Este arquivo diz **como rodar e usar**. Decisões, trade-offs e limitações estão no [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Pré-requisitos

- [Bun](https://bun.sh) 1.x — testado com 1.4.2. É runtime, gerenciador de pacotes e test runner; não há etapa de build.
- Docker com Docker Compose v2 (o setup usa `up --wait`) — testado com Compose 2.40.
- `curl`, para os exemplos.

PostgreSQL 17 (`postgres:17-alpine`) e LocalStack 4.12 (`localstack/localstack:4.12`, só SQS) são baixados pelo Compose; nada é instalado na máquina.

## Setup

```sh
bun install
docker compose up -d --wait   # PostgreSQL + LocalStack; só retorna com os dois saudáveis
bun run migration:up          # cria o schema no banco de desenvolvimento
bun run start                 # API em http://localhost:3000, com consumidor e workers ligados
```

Em outro terminal:

```sh
curl -s http://localhost:3000/health/ready
# 200 {"status":"ok","checks":{"postgres":"up","sqs":"up"}}
```

Todas as variáveis de ambiente têm default de desenvolvimento: não é preciso criar `.env`. Para mudar algo, `cp .env.example .env` (o Bun carrega o `.env` sozinho).

Para encerrar, `Ctrl+C`: a instância termina o que está em andamento antes de sair, o que pode levar até 20 s (o long polling do SQS em curso).

## Infra local

O `docker compose up -d --wait` só retorna quando:

- o PostgreSQL aceita conexões, com os bancos `wagering` (desenvolvimento) e `wagering_test` (testes);
- o LocalStack já criou as filas `wager-transactions.fifo` (entrada), `wager-transactions-dlq.fifo` (DLQ, por redrive da principal) e `wagering-events.fifo` (eventos da outbox).

```sh
docker compose down      # derruba os containers, mantém os dados do Postgres
docker compose down -v   # derruba e apaga o volume do Postgres (depois, rode migration:up de novo)
```

Se as portas padrão estiverem ocupadas, mude as portas do host e aponte a aplicação para elas:

```sh
POSTGRES_PORT=5433 LOCALSTACK_PORT=4567 docker compose up -d --wait
export DATABASE_URL=postgres://wagering:wagering@localhost:5433/wagering
export TEST_DATABASE_URL=postgres://wagering:wagering@localhost:5433/wagering_test
export AWS_ENDPOINT_URL=http://localhost:4567
```

## Comandos

| Comando | O que faz |
| --- | --- |
| `bun run start` | sobe a aplicação |
| `bun run dev` | sobe com reload automático |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test:unit` | só os testes do domínio (`test/domain`); não precisa de Docker |
| `bun run test:integration` | sobe o Compose, se preciso, e roda a suíte inteira |
| `bun run test` | roda a suíte inteira com o Compose já de pé |
| `bun run test:load` | sobe o Compose, se preciso, e roda o [teste de carga](#teste-de-carga) |
| `bun run migration:up` | aplica as migrations pendentes |
| `bun run migration:down` | reverte a última migration aplicada |
| `bun run migration:create` | cria uma migration em branco em `src/migrations/` |

As migrations são SQL escrito à mão, com `up()` e `down()`, e usam `DATABASE_URL`. O banco de testes é migrado sozinho pelo setup dos testes.

## Várias instâncias

A aplicação não roda no Compose: cada instância é um processo, e todas compartilham o mesmo Postgres e o mesmo LocalStack. Em três terminais:

```sh
PORT=3000 bun run start
PORT=3001 bun run start
PORT=3002 bun run start
```

```sh
for p in 3000 3001 3002; do curl -s http://localhost:$p/health/ready; echo; done
# {"status":"ok","checks":{"postgres":"up","sqs":"up"}}   (três vezes)
```

Por padrão toda instância atende HTTP, consome a fila, publica a outbox e reavalia pendentes — qualquer número delas pode fazer tudo isso ao mesmo tempo. Para separar papéis, desligue por instância:

```sh
# só HTTP
PORT=3001 SQS_CONSUMER_ENABLED=false OUTBOX_PUBLISHER_ENABLED=false PENDING_REFERENCE_WORKER_ENABLED=false bun run start
```

Mantenha o publisher da outbox e o worker de pendentes ligados em pelo menos uma instância. Por que isso é correto com N instâncias: [Concorrência](./ARCHITECTURE.md#concorrência).

## Configuração

Tudo que a aplicação lê está em `src/config.ts`. Valor inválido (por exemplo `PORT=abc`) encerra o processo na inicialização com uma mensagem de erro.

| Variável | Default | Descrição |
| --- | --- | --- |
| `PORT` | `3000` | porta HTTP |
| `LOG_LEVEL` | `log` | nível mínimo: `fatal`, `error`, `warn`, `log`, `debug`, `verbose` |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | banco da aplicação e das migrations |
| `DB_LOCK_TIMEOUT_MS` | `5000` | espera máxima por uma wallet travada; estourou, `503` |
| `AWS_ENDPOINT_URL` | `http://localhost:4566` | endpoint do SQS (LocalStack) |
| `AWS_REGION` | `us-east-1` | |
| `AWS_ACCESS_KEY_ID` | `test` | |
| `AWS_SECRET_ACCESS_KEY` | `test` | |
| `SQS_QUEUE_NAME` | `wager-transactions.fifo` | fila de entrada; também é a verificada pelo readiness |
| `SQS_DLQ_NAME` | `wager-transactions-dlq.fifo` | destino das mensagens que nunca serão processadas |
| `SQS_CONSUMER_ENABLED` | `true` | liga o consumidor da fila nesta instância (`true` \| `false`) |
| `SQS_CONSUMER_BATCH_SIZE` | `10` | mensagens por receive (1–10) = paralelismo da instância |
| `SQS_CONSUMER_WAIT_TIME_SECONDS` | `20` | long polling (1–20); também o máximo de espera no encerramento |
| `SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS` | `30` | deve ser maior que `DB_LOCK_TIMEOUT_MS` + 5 s |
| `SQS_CONSUMER_MAX_BACKOFF_SECONDS` | `300` | teto do adiamento após falha transitória |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | liga o publisher da outbox nesta instância (`true` \| `false`) |
| `OUTBOX_QUEUE_NAME` | `wagering-events.fifo` | fila de destino dos eventos |
| `OUTBOX_POLL_INTERVAL_MS` | `1000` | espera entre lotes quando não há backlog |
| `OUTBOX_BATCH_SIZE` | `10` | eventos reivindicados por lote |
| `OUTBOX_PUBLISH_TIMEOUT_MS` | `2000` | tempo limite de cada envio ao SQS |
| `PENDING_REFERENCE_WORKER_ENABLED` | `true` | liga o worker de `PENDING_REFERENCE` nesta instância (`true` \| `false`) |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` | `1000` | espera entre lotes quando não há pendentes vencidas |
| `PENDING_REFERENCE_BATCH_SIZE` | `20` | pendentes reavaliadas por lote |
| `PENDING_REFERENCE_TTL_SECONDS` | `900` | prazo desde o `createdAt`; esgotado, `REJECTED` com `REFERENCE_NOT_FOUND` |

Fora da aplicação, o `.env.example` traz também `TEST_DATABASE_URL` (banco usado pelo `bun test`; default `postgres://wagering:wagering@localhost:5432/wagering_test`) e `POSTGRES_PORT` / `LOCALSTACK_PORT` (portas do host no Compose; defaults `5432` e `4566`).

## API

| Método e rota | Descrição |
| --- | --- |
| `POST /wallets` | abre a wallet (saldo inicial vira uma transação `OPENING`) |
| `GET /wallets/:walletId` | saldo e versão atuais |
| `GET /wallets/:walletId/ledger?cursor=...&limit=50` | lançamentos em ordem, paginados (`limit` máximo 100) |
| `POST /wallets/:walletId/reconciliation` | compara o saldo com o ledger; nunca corrige |
| `POST /wagering/transactions` | submete uma transação; exige o header `Idempotency-Key` |
| `GET /wagering/transactions/:transactionId` | transação pelo id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | transação pelo id do provedor |
| `GET /health/live`, `GET /health/ready` | liveness e readiness |
| `GET /metrics` | métricas em formato Prometheus |

Status: `201` aplicada ou criada · `200` consulta ou replay · `202` aguardando referência · `422` rejeitada por regra de negócio (com `failureCode`) · `400` payload inválido · `404` inexistente · `409` conflito · `503` falha transitória (reenvie a mesma requisição; há `Retry-After`). Erros têm o corpo `{"error":{"code","message"}}`. Tabela completa: [Mapeamento de status HTTP](./ARCHITECTURE.md#mapeamento-de-status-http); significado de cada `failureCode`: [Códigos de falha](./ARCHITECTURE.md#códigos-de-falha).

Autenticação não é implementada: os endpoints aceitam requisições sem credenciais. Decisão e desenho pretendido: [Autenticação](./ARCHITECTURE.md#autenticação).

Toda requisição aceita o header `X-Correlation-Id`; ausente ou inválido, um UUID é gerado. O valor volta na resposta e vai para os logs e os eventos.

Os exemplos abaixo formam uma sequência; as respostas mostradas são as de um banco recém-criado. Use `curl -i` para ver o status.

```sh
BASE=http://localhost:3000
PLAYER=0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1
```

### Criar e consultar wallet

```sh
curl -s -X POST $BASE/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}"
# 201 {"id":"01a1044e-368e-75f0-84fd-8932405117a2","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","balance":{"amount":"1000.00","currency":"BRL"},"version":1}
# repetir: 409 {"error":{"code":"WALLET_ALREADY_EXISTS","message":"Já existe wallet para este jogador nesta moeda"}}

WALLET=01a1044e-368e-75f0-84fd-8932405117a2   # o "id" devolvido acima

curl -s $BASE/wallets/$WALLET
# 200 {"id":"01a1044e-...","playerId":"0192f28f-...","balance":{"amount":"1000.00","currency":"BRL"},"version":1}
```

### Submeter transação

```sh
curl -s -X POST $BASE/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-123\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
# 201 {"transactionId":"01a1044e-36d0-7463-ac14-7af1cb455638","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

Repetir exatamente o mesmo comando — em qualquer instância — devolve o resultado original:

```sh
# 200 {"transactionId":"01a1044e-36d0-7463-ac14-7af1cb455638","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":true}
```

Outros desfechos, variando o comando acima:

| Variação | Resposta |
| --- | --- |
| mesma `Idempotency-Key`, `amount` `26.00` | `409` `{"error":{"code":"IDEMPOTENCY_KEY_CONFLICT","message":"Idempotency-Key já usada com outro payload"}}` |
| chave e `externalTransactionId` novos, `amount` `5000.00` | `422` `{"transactionId":"...","status":"REJECTED","failureCode":"INSUFFICIENT_FUNDS","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}` |
| `kind` `REFUND` com `referenceExternalTransactionId` de uma transação que ainda não chegou | `202` `{"transactionId":"...","status":"PENDING_REFERENCE","idempotentReplay":false}` |
| sem o header `Idempotency-Key` | `400` `{"error":{"code":"MISSING_IDEMPOTENCY_KEY","message":"O header Idempotency-Key é obrigatório"}}` |

Uma transação `PENDING_REFERENCE` é reavaliada por um worker: quando a referência chega, ela é aplicada pelas mesmas regras; se não chegar em `PENDING_REFERENCE_TTL_SECONDS` (15 min), fica `REJECTED` com `REFERENCE_NOT_FOUND`. O replay com a mesma chave devolve o estado atual. Detalhes: [Worker de PENDING_REFERENCE](./ARCHITECTURE.md#worker-de-pending_reference) e [Idempotência](./ARCHITECTURE.md#idempotência).

### Consultar transação

```sh
TX=01a1044e-36d0-7463-ac14-7af1cb455638   # o "transactionId" devolvido na submissão

curl -s $BASE/wagering/transactions/$TX
curl -s $BASE/providers/provider-a/wagering/transactions/transaction-123
# as duas: 200 {"transactionId":"01a1044e-36d0-...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},
#   "providerId":"provider-a","externalTransactionId":"transaction-123","walletId":"01a1044e-368e-...","playerId":"0192f28f-...",
#   "roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},
#   "createdAt":"2026-10-04T00:26:37.136Z","completedAt":"2026-10-04T00:26:37.136Z"}
```

### Ledger paginado

```sh
curl -s "$BASE/wallets/$WALLET/ledger?limit=1"
# 200 {"entries":[{"id":"01a1044e-368f-...","transactionId":"01a1044e-368e-...","direction":"CREDIT","money":{"amount":"1000.00","currency":"BRL"},
#   "balanceBefore":{"amount":"0.00","currency":"BRL"},"balanceAfter":{"amount":"1000.00","currency":"BRL"},"createdAt":"2026-10-04T00:26:37.070Z"}],
#   "nextCursor":"MQ"}

curl -s "$BASE/wallets/$WALLET/ledger?limit=1&cursor=MQ"
# 200 {"entries":[{"id":"01a1044e-36e4-...","transactionId":"01a1044e-36d0-...","direction":"DEBIT","money":{"amount":"25.00","currency":"BRL"},
#   "balanceBefore":{"amount":"1000.00","currency":"BRL"},"balanceAfter":{"amount":"975.00","currency":"BRL"},"createdAt":"2026-10-04T00:26:37.136Z"}]}
```

O cursor é opaco; a última página não traz `nextCursor`.

### Reconciliação

```sh
curl -s -X POST $BASE/wallets/$WALLET/reconciliation
# 200 {"walletId":"01a1044e-368e-...","storedBalance":{"amount":"975.00","currency":"BRL"},"calculatedBalance":{"amount":"975.00","currency":"BRL"},
#   "difference":{"amount":"0.00","currency":"BRL"},"consistent":true,"chainIntact":true,"checkedEntries":2}
```

Uma divergência também responde `200`, com `consistent: false`; o saldo nunca é corrigido. O que cada campo significa: [Reconciliação](./ARCHITECTURE.md#reconciliação).

### Health e métricas

Sem autenticação.

```sh
curl -s $BASE/health/live
# 200 {"status":"ok"}

curl -s $BASE/health/ready
# 200 {"status":"ok","checks":{"postgres":"up","sqs":"up"}}
# 503 {"status":"error","checks":{"postgres":"down","sqs":"up"}}   se alguma dependência falhar

curl -s $BASE/metrics | grep -v '^#' | grep -v _bucket
# wagering_transactions_total{kind="OPENING",status="PROCESSED",channel="http"} 1
# wagering_transactions_total{kind="BET",status="PROCESSED",channel="http"} 1
# wagering_processing_duration_seconds_count{channel="http"} 4
# wagering_reconciliation_divergences_total 0
# wagering_outbox_oldest_pending_age_seconds 0
# wagering_dlq_depth 0
# ...
```

Os contadores são por instância: faça o scrape de cada uma. Lista das métricas, formato dos logs e correlação: [Observabilidade](./ARCHITECTURE.md#observabilidade).

## Fila de entrada

As mesmas transações podem chegar por `wager-transactions.fifo`. O consumidor executa o mesmo use case da API, com a mesma idempotência: uma transação enviada por HTTP e pela fila tem um único efeito.

```sh
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET" --message-deduplication-id msg-123 \
  --message-body "{\"messageId\":\"msg-123\",\"type\":\"WagerTransactionRequested\",\"occurredAt\":\"2026-07-29T15:00:00.000Z\",\"data\":{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-456\",\"idempotencyKey\":\"provider-a:transaction-456\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}}"
# {"MD5OfMessageBody":"...","MessageId":"...","SequenceNumber":"..."}

curl -s $BASE/providers/provider-a/wagering/transactions/transaction-456
# 200 {"transactionId":"...","status":"PROCESSED","balance":{"amount":"950.00","currency":"BRL"},...,"externalTransactionId":"transaction-456",...}
```

Use o `walletId` como `MessageGroupId` para preservar a ordem das operações de uma wallet.

Mensagem que nunca será aceita (envelope ou payload inválido, wallet inexistente, conflito de idempotência) vai para a DLQ com o atributo `reason`; a que esgota as tentativas chega lá pelo redrive, sem `reason`:

```sh
docker compose exec localstack awslocal sqs receive-message --max-number-of-messages 10 --message-attribute-names All \
  --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-transactions-dlq.fifo
```

Classificação de erros, retry e encerramento: [Consumidor da fila](./ARCHITECTURE.md#consumidor-da-fila).

## Eventos publicados

Cada transação grava seus eventos na outbox, na mesma transação SQL, e um worker os publica em `wagering-events.fifo`. A entrega é **at-least-once**: quem consome deve deduplicar por `eventId`.

```sh
docker compose exec localstack awslocal sqs receive-message --max-number-of-messages 10 \
  --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wagering-events.fifo
# {"Messages":[{"MessageId":"...","ReceiptHandle":"...","Body":"{\"data\":{\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"},\"walletId\":\"01a1044e-368e-...\",
#   \"direction\":\"DEBIT\",\"balanceAfter\":{\"amount\":\"975.00\",\"currency\":\"BRL\"},\"balanceBefore\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"},
#   \"transactionId\":\"01a1044e-36d0-...\",\"walletVersion\":2},\"eventId\":\"01a1044e-36ee-...\",\"version\":1,\"eventType\":\"WalletBalanceChanged\",
#   \"occurredAt\":\"2026-10-04T00:26:37.136Z\",\"aggregateId\":\"01a1044e-368e-...\",\"correlationId\":\"5a2bf6be-...\"}"}, ...]}
```

Tipos: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged`. Garantias e ordenação: [Transactional outbox](./ARCHITECTURE.md#transactional-outbox).

## Testes

Os testes de integração rodam contra o PostgreSQL e o LocalStack reais do Compose — sem mocks. Os unitários do domínio (`test/domain/`) são puros e não precisam de Docker.

```sh
bun run test:unit          # só o domínio, sem Docker
bun run test:integration   # sobe o Compose (se preciso) e roda a suíte inteira
bun run test               # roda a suíte inteira com o Compose já de pé
bun run typecheck
```

Antes de rodar a suíte, encerre as instâncias da aplicação: elas consomem as mesmas filas que os testes usam. Se as dependências não estiverem acessíveis, a suíte falha logo no setup com uma mensagem indicando o que subir.

Onde está cada teste obrigatório do enunciado: [Testes obrigatórios (§13)](./ARCHITECTURE.md#testes-obrigatórios-13).

## Teste de carga

```sh
bun run test:load
```

Sobe 3 instâncias reais contra o Postgres e o LocalStack do Compose, aplica quatro cenários em taxa constante (`mixed`, `hot`, `replay`, `sqs`), verifica a correção nas wallets usadas e reescreve o bloco de resultados do [`LOAD_TEST.md`](./LOAD_TEST.md) — onde estão a metodologia, os números da execução de referência e a análise. Não faz parte do `test:integration`.

Com os defaults leva cerca de 2 minutos. Sai com código diferente de zero se a verificação de correção falhar. Como na suíte, encerre antes as instâncias da aplicação; a carga fica gravada no banco `wagering_test`.

| Variável | Default | Descrição |
| --- | --- | --- |
| `LOAD_SCENARIOS` | `mixed,hot,replay,sqs` | cenários a rodar, nesta ordem |
| `LOAD_RATE` | `100` | requisições por segundo |
| `LOAD_DURATION_S` | `20` | janela medida de cada cenário |
| `LOAD_<CENÁRIO>_RATE`, `LOAD_<CENÁRIO>_DURATION_S` | — | sobrepõe por cenário, ex.: `LOAD_HOT_RATE=150` |
| `LOAD_WARMUP_S` | `5` | aquecimento descartado, por cenário |
| `LOAD_WALLETS` | `200` | wallets nos cenários `mixed`, `replay` e `sqs` |
| `LOAD_REPLAY_FRACTION` | `0.3` | fração de replays no cenário `replay` |
| `LOAD_TIMEOUT_MS` | `10000` | timeout de cada requisição no cliente |
