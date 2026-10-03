#!/bin/sh
# Executado pelo LocalStack quando o serviço fica pronto. create-queue com os
# mesmos atributos é idempotente.
set -eu

dlq_url=$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true \
  --query QueueUrl --output text)

dlq_arn=$(awslocal sqs get-queue-attributes \
  --queue-url "$dlq_url" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

# maxReceiveCount 8: com o backoff do consumidor (1, 2, 4… s por recebimento) tolera ~4 min de
# banco fora antes de uma mensagem válida ir para a DLQ (ARCHITECTURE.md).
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$dlq_arn\\\",\\\"maxReceiveCount\\\":\\\"8\\\"}\"}"

# Destino do publisher da outbox. Sem ContentBasedDeduplication: o publisher manda o eventId
# como MessageDeduplicationId. Criada por último: é a fila que o healthcheck do Compose consulta.
awslocal sqs create-queue \
  --queue-name wagering-events.fifo \
  --attributes FifoQueue=true
