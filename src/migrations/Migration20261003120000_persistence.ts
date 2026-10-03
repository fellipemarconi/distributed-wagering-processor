import { Migration } from '@mikro-orm/migrations';

// Fonte da verdade do schema. Cada constraint e a invariante que ela protege estão catalogadas
// no design da change `persistence` (D5) / ARCHITECTURE.md.
export class Migration20261003120000_persistence extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id text not null,
        currency text not null,
        balance numeric(19,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint uq_wallets_player_currency unique (player_id, currency),
        constraint ck_wallets_balance_non_negative check (balance >= 0),
        constraint ck_wallets_version_positive check (version >= 1),
        constraint ck_wallets_currency_iso check (currency ~ '^[A-Z]{3}$')
      )
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null,
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(19,2) not null,
        currency text not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid,
        status text not null,
        failure_code text,
        processed_at timestamptz,
        completed_at timestamptz,
        result_balance_amount numeric(19,2),
        result_balance_currency text,
        reference_attempts integer not null default 0,
        next_reference_attempt_at timestamptz,
        created_at timestamptz not null,
        constraint uq_wager_tx_provider_external unique (provider_id, external_transaction_id),
        constraint uq_wager_tx_provider_idempotency_key unique (provider_id, idempotency_key),
        -- redundante com a PK: existe para ser alvo da FK composta do ledger
        constraint uq_wager_tx_id_wallet unique (id, wallet_id),
        constraint ck_wager_tx_kind check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint ck_wager_tx_status
          check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint ck_wager_tx_amount_non_negative check (amount >= 0),
        constraint ck_wager_tx_currency_iso check (currency ~ '^[A-Z]{3}$'),
        constraint ck_wager_tx_reversal_has_reference
          check (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
        constraint ck_wager_tx_failure_code
          check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
        constraint ck_wager_tx_processed_at check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint ck_wager_tx_completed_at
          check ((status in ('PROCESSED','REJECTED','FAILED')) = (completed_at is not null)),
        constraint ck_wager_tx_result_balance check (
          (status in ('PROCESSED','REJECTED')) = (result_balance_amount is not null)
          and (result_balance_amount is null) = (result_balance_currency is null)
          and result_balance_amount >= 0
          and result_balance_currency ~ '^[A-Z]{3}$'
        ),
        -- NULL não colide em índice único: sem isto uma reversão aplicada sem referência
        -- resolvida escaparia de uq_wager_tx_processed_reversal
        constraint ck_wager_tx_processed_reversal_resolved
          check (kind not in ('REFUND','ROLLBACK') or status <> 'PROCESSED' or reference_transaction_id is not null),
        constraint ck_wager_tx_reference_attempts check (reference_attempts >= 0),
        constraint fk_wager_tx_wallet foreign key (wallet_id) references wallets (id),
        constraint fk_wager_tx_reference foreign key (reference_transaction_id) references wager_transactions (id)
      )
    `);
    this.addSql(`
      create unique index uq_wager_tx_processed_reversal on wager_transactions (reference_transaction_id)
        where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED'
    `);
    this.addSql(`
      create unique index uq_wager_tx_opening_per_wallet on wager_transactions (wallet_id)
        where kind = 'OPENING'
    `);
    this.addSql(`
      create index ix_wager_tx_pending_reference_due on wager_transactions (next_reference_attempt_at nulls first)
        where status = 'PENDING_REFERENCE'
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        seq bigint generated always as identity,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction text not null,
        amount numeric(19,2) not null,
        currency text not null,
        balance_before numeric(19,2) not null,
        balance_after numeric(19,2) not null,
        created_at timestamptz not null,
        constraint uq_ledger_transaction_wallet unique (transaction_id, wallet_id),
        constraint uq_ledger_wallet_seq unique (wallet_id, seq),
        constraint ck_ledger_direction check (direction in ('DEBIT','CREDIT')),
        constraint ck_ledger_amount_positive check (amount > 0),
        constraint ck_ledger_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
        constraint ck_ledger_arithmetic check (
          balance_after = case direction when 'CREDIT' then balance_before + amount else balance_before - amount end
        ),
        constraint ck_ledger_currency_iso check (currency ~ '^[A-Z]{3}$'),
        constraint fk_ledger_wallet foreign key (wallet_id) references wallets (id),
        -- composta: o lançamento pertence à wallet da própria transação
        constraint fk_ledger_transaction foreign key (transaction_id, wallet_id)
          references wager_transactions (id, wallet_id)
      )
    `);
    this.addSql(`
      create function forbid_ledger_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries é append-only (% bloqueado)', tg_op;
      end
      $$
    `);
    this.addSql(`
      create trigger trg_ledger_no_update_delete before update or delete on wallet_ledger_entries
        for each row execute function forbid_ledger_mutation()
    `);
    // TRUNCATE não dispara trigger de linha.
    this.addSql(`
      create trigger trg_ledger_no_truncate before truncate on wallet_ledger_entries
        for each statement execute function forbid_ledger_mutation()
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint pk_inbox_messages primary key (consumer_name, message_id)
      )
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        constraint ck_outbox_attempts_non_negative check (attempts >= 0)
      )
    `);
    this.addSql(`
      create index ix_outbox_pending on outbox_messages (next_attempt_at nulls first)
        where published_at is null
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table outbox_messages');
    this.addSql('drop table inbox_messages');
    this.addSql('drop table wallet_ledger_entries');
    this.addSql('drop function forbid_ledger_mutation()');
    this.addSql('drop table wager_transactions');
    this.addSql('drop table wallets');
  }
}
