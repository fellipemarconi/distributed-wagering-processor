# Teste de carga

Diferencial opcional do [`CHALLENGE.md`](./CHALLENGE.md) §14. Não há meta de RPS: o objetivo é registrar como o sistema se comporta sob carga sustentada e comprovar que continua correto. Como rodar: [README](./README.md#teste-de-carga).

O bloco abaixo (ambiente, parâmetros, resultados, verificação) é gerado por `bun run test:load` e sobrescrito a cada execução. [Metodologia](#metodologia), [análise](#análise) e [limitações](#limitações-do-experimento) vêm depois dele, escritas à mão sobre a execução de referência registrada aqui.

<!-- load-test:begin -->
<!-- Gerado por `bun run test:load`. Não edite entre os marcadores: a próxima execução sobrescreve. -->

## Ambiente

- Data: 2026-10-04T01:44:44.552Z · commit `d1628b8`
- CPU: Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz · 28 CPUs lógicas
- RAM: 7.7 GiB
- SO: Linux 6.6.87.2-microsoft-standard-WSL2 (x64)
- Bun: 1.4.2
- Docker: 29.1.3 · 28 CPUs · 8272363520 bytes de memória
- PostgreSQL: PostgreSQL 17.11 · LocalStack 4.12 (SQS), ambos pelo Compose
- Gerador de carga, 3 instâncias da aplicação e containers na mesma máquina

## Parâmetros

- Instâncias: 3 processos `bun src/main.ts`, configuração padrão exceto `LOG_LEVEL=warn`, `SQS_CONSUMER_ENABLED=true`, `OUTBOX_PUBLISHER_ENABLED=true`, `PENDING_REFERENCE_WORKER_ENABLED=true`, `SQS_CONSUMER_WAIT_TIME_SECONDS=1`
- Aquecimento descartado: 5 s por cenário · timeout por requisição: 10000 ms · fração de replays: 0.3
- Mistura: `BET 25.00` 60%, `WIN 40.00` 20%, `LOSS` 20%

| Cenário | Taxa alvo (req/s) | Janela medida (s) | Wallets |
| --- | --- | --- | --- |
| mixed | 100 | 20 | 200 |
| hot | 100 | 20 | 1 |
| replay | 100 | 20 | 200 |
| sqs | 100 | 20 | 200 |

## Resultados

Latência HTTP em ms, medida a partir do instante **agendado** de cada requisição.

| Cenário | Enviadas | Respostas HTTP/s | p50 | p95 | p99 | max | Atraso do gerador p99 / max | Média no servidor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mixed | 2000 | 100.0 | 14.5 | 18.0 | 25.5 | 48.8 | 1.3 / 8.5 | 12.8 |
| hot | 2000 | 89.9 | 1169.3 | 2198.2 | 2461.2 | 2665.6 | 1.4 / 6.9 | 1161.2 |
| replay | 2000 | 100.0 | 13.5 | 15.9 | 21.6 | 44.5 | 1.2 / 5.7 | 10.4 |
| sqs | 2000 | 50.0 | 14.6 | 21.1 | 41.0 | 198.9 | 1.2 / 6.2 | 14.3 |

Respostas por status HTTP (`422` = rejeição de negócio; `503` = falha transitória; `timeout`/`erro` = sem resposta):

| Cenário | Status |
| --- | --- |
| mixed | 201=1923 422=77 |
| hot | 201=2000 |
| replay | 200=619 201=1381 |
| sqs | 201=1000 |

Métricas do `/metrics` (variação na janela medida + drenagem, somada nas 3 instâncias):

| Cenário | Conflitos de lock | Retries | Duplicatas | Outbox: idade máx. da pendente (s) | Outbox: publish lag médio (ms) | Drenagem após o fim (s) |
| --- | --- | --- | --- | --- | --- | --- |
| mixed | 0 | 0 | 0 | 1.00 | 530.0 | 0.36 |
| hot | 0 | 0 | 0 | 14.98 | 8661.4 | 6.54 |
| replay | 0 | 0 | idempotent_replay=619 | 0.89 | 517.7 | 0.76 |
| sqs | 0 | 0 | 0 | 0.80 | 279.6 | 0.24 |

Cenário `sqs`, metade pela fila: 1000 mensagens; latência ponta a ponta (instante agendado do envio → `completed_at`), ms: p50 14.9 · p95 24.9 · p99 48.9 · max 200.9; média de processamento no servidor (canal `sqs`): 26.9 ms.

## Verificação de correção

Por cenário, nas wallets usadas: reconciliação `consistent: true`, saldo = abertura ± transações `PROCESSED`, uma transação por idempotency key, um lançamento por transação, nada em estado não terminal.

- `mixed`: ✔
- `hot`: ✔
- `replay`: ✔
- `sqs`: ✔

<!-- load-test:end -->

## Metodologia

O script é `test/load.ts` (Bun/TypeScript, sem dependência extra).

- **Sistema sob teste**: 3 processos reais da aplicação (`bun src/main.ts`), cada um com consumidor da fila, publisher da outbox e worker de pendentes ligados, contra o PostgreSQL e o LocalStack do Compose, no banco `wagering_test`. A configuração é a padrão, exceto o que está listado em "Parâmetros".
- **Taxa de chegada constante (open-loop)**: a requisição `i` é agendada para `início + i/taxa` e disparada sem esperar as anteriores. A latência é contada **a partir do instante agendado**, não do envio. Um gerador em laço fechado deixaria de enviar enquanto o servidor estivesse lento e esconderia exatamente a cauda (coordinated omission).
- **Distribuição**: round-robin entre as 3 instâncias.
- **Fora da janela medida**: criação das wallets e um aquecimento na mesma taxa, cujas amostras são descartadas.
- **Atraso do gerador**: a diferença entre o disparo real e o instante agendado é registrada. Se ela fosse alta, a latência reportada seria do gerador, não do sistema.
- **Métricas do servidor**: `/metrics` das 3 instâncias lido antes da janela e depois da drenagem; a tabela traz a diferença, somada. O gauge `wagering_outbox_oldest_pending_age_seconds` é amostrado a cada 1 s e a tabela traz o máximo.
- **Drenagem**: tempo, depois da última resposta, até a fila de entrada e a outbox ficarem vazias.
- **"Média no servidor"**: `wagering_processing_duration_seconds` (Δsum/Δcount) do canal `http`.
- **Cenários**: `mixed` (wallets sorteadas entre 200; 10% delas abrem com `50.00`, o resto com `100000.00`), `hot` (uma única wallet), `replay` (30% das requisições repetem chave e payload de uma das últimas 50 enviadas), `sqs` (requisições pares por HTTP, ímpares por `wager-transactions.fifo` com `MessageGroupId = walletId`).
- **Verificação de correção**: depois de cada cenário, nas wallets dele. Qualquer falha faz o comando sair com código diferente de zero. Respostas `5xx` e timeouts não derrubam o comando: são resultado do experimento.

## Análise

Tudo abaixo se refere à execução registrada no bloco gerado, mais duas execuções complementares da hot wallet descritas adiante. É uma execução por configuração, sem repetições: diferenças de poucos milissegundos entre cenários não devem ser lidas como significativas.

### O gerador não foi o limite

O atraso do gerador ficou em 1,2–1,8 ms no p99 e abaixo de 6 ms no máximo em todos os cenários. As latências reportadas são do sistema.

### Carga espalhada (`mixed`, `replay`, `sqs`)

- A 100 req/s em 200 wallets o sistema acompanhou a taxa (100,0 respostas/s), com p50 de 14,8 ms e p99 de 27,3 ms. A média medida no servidor (13,3 ms) explica quase toda a latência vista pelo cliente.
- Nenhum conflito de lock, nenhum retry e nenhum `5xx` nesses três cenários. Esta execução não chegou perto do limite da carga espalhada, então **ela não diz qual é esse limite nem onde está o gargalo** nesse caso.
- As 45 respostas `422` do `mixed` são `BET` em wallets abertas com `50.00`: rejeição de negócio, contada à parte dos erros.
- No `replay`, 611 das 2000 requisições (30,6%) voltaram `200` e o contador `idempotent_replay` subiu exatamente 611. Mesmo com replays disparados enquanto a original podia estar em andamento, não houve nenhuma `unique_violation`. Isso é coerente com o desenho (duplicatas da mesma chave têm a mesma wallet e se enfileiram no lock), mas a execução não mede quantos replays de fato se sobrepuseram à original.
- No `sqs`, as 1000 mensagens foram consumidas com latência ponta a ponta de 13,0 ms (p50) e 55,0 ms (p99), e a DLQ ficou vazia. A média de processamento do canal `sqs` (25,4 ms) é maior que a do `http`; a execução não separa as parcelas desse tempo, então a causa não foi determinada.

### Hot wallet × `mixed` na mesma taxa

| | `mixed`, 100 req/s | `hot`, 100 req/s |
| --- | --- | --- |
| respostas/s | 100,0 | 88,6 |
| p50 / p99 / max (ms) | 14,8 / 27,3 / 49,4 | 1242,4 / 2732,3 / 2957,4 |
| média no servidor (ms) | 13,3 | 1259,1 |
| status | 1955 × `201`, 45 × `422` | 2000 × `201` |
| conflitos de lock | 0 | 0 |

A mesma taxa que 200 wallets absorvem com folga não cabe em uma wallet só. Com o lock pessimista por wallet (`SELECT ... FOR UPDATE` na linha da wallet), as transações de uma mesma wallet rodam uma por vez, em qualquer instância. A hot wallet entregou 88,6 transações/s — cerca de 11 ms por transação, em série. Como chegavam 100 por segundo, a fila cresceu durante toda a janela: a latência não estabilizou, subiu até ~3 s ao fim de 20 s, e continuaria subindo com uma janela maior. As 2000 requisições foram aplicadas, nenhuma se perdeu ou duplicou, e a wallet reconciliou.

Duas execuções complementares, só do cenário `hot` (`LOAD_SCENARIOS=hot LOAD_HOT_RATE=…`, demais parâmetros iguais), delimitam esse comportamento:

| `hot` | respostas/s | p50 / p99 (ms) | média no servidor (ms) | status | conflitos de lock | outbox: idade máx. (s) / publish lag médio (ms) | drenagem (s) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 50 req/s | 50,0 | 16,0 / 27,6 | 14,1 | 1000 × `201` | 0 | 0,94 / 521,7 | 0,35 |
| 100 req/s (referência) | 88,6 | 1242,4 / 2732,3 | 1259,1 | 2000 × `201` | 0 | 15,91 / 9398,8 | 6,97 |
| 150 req/s | 67,7 | 7484,9 / 10001,6 | 3044,9 | 2032 × `201`, 968 × timeout | 0 | 40,40 / 29097,1 | 21,85 |

- **Abaixo da capacidade serial (50 req/s)** a hot wallet se comporta como o `mixed`: o lock por wallet não custa nada mensurável enquanto a wallet dá conta da taxa.
- **Acima dela (150 req/s)** um terço das requisições estourou o timeout de 10 s do cliente. As "67,7 respostas/s" contam só as respostas que chegaram dentro do timeout, na janela mais a cauda de espera — não são a vazão do servidor, que continuou processando as requisições abandonadas (21,85 s de drenagem). Reenviar com a mesma `Idempotency-Key` é seguro; a verificação de correção passou também nessa execução.

### Por que não apareceu `503` / `lock_timeout`

A expectativa era que a hot wallet saturada produzisse `503` (espera pelo lock acima de `DB_LOCK_TIMEOUT_MS`, 5 s) e `wagering_lock_conflicts_total{type="lock_timeout"}`. **Não produziu, nem a 150 req/s**: zero `503` e zero conflitos de lock.

Durante a execução a 150 req/s, `pg_stat_activity` foi amostrado a cada 3 s: 31 conexões no banco (10 por instância mais a do próprio script) e, de forma estável, 26 a 29 delas esperando lock. Ou seja, o número de transações que esperam o lock da wallet ao mesmo tempo é limitado pelo tamanho do pool de conexões — no máximo 30. Com ~11 ms por transação, quem entra nessa fila espera na ordem de 0,3 s pelo lock (estimativa a partir dos dois números, não medida diretamente), muito abaixo de 5 s. O resto da espera acontece **antes** do lock, na fila por uma conexão do pool, que não tem o limite de 5 s.

Consequência: nesta configuração, a sobrecarga de uma hot wallet aparece para o cliente como latência crescente e timeout, não como `503` com `Retry-After`. O `lock_timeout` continua cumprindo o papel de impedir que uma transação travada segure conexão indefinidamente, mas não funciona como sinal de sobrecarga de uma wallet quente. Esse comportamento está registrado no [`ARCHITECTURE.md`](./ARCHITECTURE.md#lock_timeout-e-o-503).

### Outbox lag

- Sem saturação (`mixed`, `replay`, `hot` a 50 req/s), o publish lag médio ficou em 513–522 ms e a pendente mais antiga não passou de 1,0 s; a outbox esvaziou em menos de 1 s depois do fim da carga. Esse patamar é compatível com o intervalo de polling do publisher (`OUTBOX_POLL_INTERVAL_MS`, 1000 ms), mas a execução não varia esse parâmetro para confirmar.
- No `sqs` o lag médio foi menor (172,7 ms). A causa não foi investigada.
- Com a hot wallet saturada, o lag subiu para 9,4 s de média a 100 req/s e 29,1 s a 150 req/s, com pendente de até 40,4 s. A quantidade de eventos por segundo não é maior que no `mixed`, então a causa não é volume. **Hipótese**: o publisher usa o mesmo pool de conexões das requisições; com 26–29 das 30 conexões paradas na fila do lock da wallet, ele espera por conexão como qualquer requisição. A amostragem de `pg_stat_activity` sustenta a premissa (pool ocupado), mas o tempo de espera do publisher por conexão não foi medido.

O efeito prático é que uma única wallet saturada atrasa a publicação dos eventos de **todas** as wallets atendidas pelas mesmas instâncias. Nenhum evento se perde: a outbox esvaziou em todas as execuções.

### Correção sob carga

Em todas as execuções (referência e complementares), todas as wallets reconciliaram com `consistent: true`, o saldo bateu com abertura ± transações `PROCESSED`, não houve chave de idempotência com duas transações nem transação com dois lançamentos, e nada ficou em estado não terminal. A verificação foi testada contra si mesma: com a expectativa de saldo alterada de propósito, o comando acusou a divergência e saiu com código 1.

## Limitações do experimento

- **Tudo na mesma máquina** (WSL2): gerador, 3 instâncias, PostgreSQL e LocalStack disputam CPU, memória e disco. Não há latência de rede entre cliente, aplicação e banco.
- **LocalStack não é o SQS real**: sem latência de rede, sem os limites de vazão de fila FIFO, e com comportamento próprio sob carga. Os números do cenário `sqs` e do outbox lag não se transferem para a AWS.
- **A carga não exercita `REFUND` nem `ROLLBACK`, nem o caminho `PENDING_REFERENCE`** (reversão antes da referência, worker de pendentes resolvendo ou expirando). Só `BET`, `WIN` e `LOSS`. Esses caminhos são cobertos por testes de correção, não por medição de desempenho.
- **Taxas modestas e janela curta** (20 s): a carga espalhada não foi levada à saturação, então o experimento não mede a capacidade máxima do sistema nem aponta o gargalo fora do caso da hot wallet.
- **Uma execução por configuração**, sem repetições nem intervalo de confiança.
- **Percentis do lado do cliente**; do servidor só há a média (Δsum/Δcount do histograma).
- **`LOG_LEVEL=warn`** nas instâncias: o log por requisição do nível padrão está desligado, o que favorece os números.
- **Banco de testes já povoado** por execuções anteriores da suíte e do próprio teste de carga; o tamanho das tabelas não foi controlado.
- **Sem teto de requisições em voo no gerador**: em sobrecarga, o limite de conexões simultâneas do `fetch` do Bun pode acrescentar espera no cliente. Ela entra na latência (correto em open-loop), mas não é separada da espera no servidor.
- **A explicação da ausência de `503`** combina uma medida (conexões esperando lock) com uma estimativa (tempo de espera pelo lock); a espera por conexão do pool não foi instrumentada.
