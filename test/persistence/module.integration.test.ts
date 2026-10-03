import { expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { Clock, IdGenerator, TransactionRunner, WalletRepository } from '../../src/application/ports';
import { loadConfig } from '../../src/config';
import { Wallet } from '../../src/domain/wallet';
import { brl } from '../domain/fixtures';

test('AppModule resolve as portas e grava/lê uma wallet dentro de uma transação', async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(loadConfig())] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  try {
    const ids = app.get(IdGenerator);
    const clock = app.get(Clock);
    const wallets = app.get(WalletRepository);
    const runner = app.get(TransactionRunner);

    const { wallet } = Wallet.open({ id: ids.next(), playerId: ids.next(), initialBalance: brl('0.00'), at: clock.now() });
    const read = await runner.run(async () => {
      await wallets.add(wallet);
      return wallets.findByIdForUpdate(wallet.id);
    });

    expect(read).toEqual(wallet);
  } finally {
    await app.close();
  }
});
