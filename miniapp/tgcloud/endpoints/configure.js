import { assertUser, workerCall } from '../lib/worker.js';

// Configura somente o grid do usuário autenticado pelo Telegram.
export default async function (input, ctx) {
  const userId = await assertUser(ctx);
  const { market, low, high, levels, marginUsd, leverage } = input;
  return workerCall('grid', { method: 'POST', body: { market, low, high, levels, marginUsd, leverage }, userId });
}
