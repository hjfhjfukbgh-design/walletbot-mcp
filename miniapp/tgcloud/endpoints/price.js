import { EndpointError } from 'sdk';
import { assertUser, workerCall } from '../lib/worker.js';

export default async function (input, ctx) {
  const userId = await assertUser(ctx);
  const market = String(input.market ?? '').toUpperCase();
  if (!/^[A-Z0-9]{1,20}$/.test(market)) throw new EndpointError('market inválido', { code: 'BAD_INPUT' });
  const leverage = Number(input.leverage ?? 3) || 3;
  return workerCall(`price?market=${encodeURIComponent(market)}&leverage=${leverage}`, { userId });
}
