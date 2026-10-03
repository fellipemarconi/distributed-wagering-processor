import { LedgerDirection } from '../domain/ledger-entry';
import { Money } from '../domain/money';
import { LedgerRepository, TransactionRunner, WalletRepository } from './ports';

export type ReconcileWalletResult =
  | { outcome: 'not-found' }
  | {
      outcome: 'reconciled';
      walletId: string;
      storedBalance: Money;
      /** Σ créditos − Σ débitos do ledger. */
      calculatedBalance: Money;
      /** storedBalance − calculatedBalance (pode ser negativa). */
      difference: Money;
      /** Cada lançamento parte do saldo em que o anterior terminou, e o último termina no saldo armazenado. */
      chainIntact: boolean;
      consistent: boolean;
      checkedEntries: number;
      /** Primeiro lançamento que não parte do saldo deixado pelo anterior (diagnóstico). */
      firstBrokenEntryId?: string;
    };

const PAGE_SIZE = 1000;

/**
 * Compara o saldo armazenado com o ledger em uma única foto do banco. Só lê — não recebe nenhuma
 * dependência de escrita e roda em transação somente leitura: divergência é relatada, nunca corrigida.
 */
export class ReconcileWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
  ) {}

  // ponytail: percorre o ledger inteiro a cada chamada (O(lançamentos), memória constante). Guardar
  // um checkpoint (saldo verificado até um seq) se o ledger por wallet crescer a ponto de importar.
  execute(walletId: string): Promise<ReconcileWalletResult> {
    return this.runner.snapshot<ReconcileWalletResult>(async () => {
      const wallet = await this.wallets.findById(walletId);
      if (!wallet) return { outcome: 'not-found' };

      const storedBalance = wallet.balance;
      let calculatedBalance = Money.zero(wallet.currency);
      let previousAfter = calculatedBalance; // a corrente parte de zero
      let checkedEntries = 0;
      let firstBrokenEntryId: string | undefined;
      let after: string | undefined;
      do {
        const page = await this.ledger.listByWallet(walletId, { after, limit: PAGE_SIZE });
        for (const entry of page.entries) {
          calculatedBalance =
            entry.direction === LedgerDirection.Credit
              ? calculatedBalance.add(entry.money)
              : calculatedBalance.subtract(entry.money);
          if (!entry.balanceBefore.equals(previousAfter)) firstBrokenEntryId ??= entry.id;
          previousAfter = entry.balanceAfter;
          checkedEntries += 1;
        }
        after = page.nextCursor;
      } while (after !== undefined);

      const difference = storedBalance.subtract(calculatedBalance);
      const chainIntact = firstBrokenEntryId === undefined && previousAfter.equals(storedBalance);
      return {
        outcome: 'reconciled',
        walletId,
        storedBalance,
        calculatedBalance,
        difference,
        chainIntact,
        consistent: difference.isZero() && chainIntact,
        checkedEntries,
        firstBrokenEntryId,
      };
    });
  }
}
