import { assertUser, workerCall } from '../lib/worker.js';

export default async function (input, ctx) {
  const userId = await assertUser(ctx);
  return workerCall('contracts', { userId });
}
