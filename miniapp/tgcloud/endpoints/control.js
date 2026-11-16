import { EndpointError } from 'sdk';
import { assertUser, workerCall } from '../lib/worker.js';

const ACTIONS = ['run', 'stop', 'resume', 'closeall', 'mode'];

export default async function (input, ctx) {
  const userId = await assertUser(ctx);
  if (!ACTIONS.includes(input.action)) throw new EndpointError('ação inválida', { code: 'BAD_INPUT' });
  return workerCall('control', {
    method: 'POST',
    body: { action: input.action, mode: input.mode, confirm: input.confirm === true },
    userId,
  });
}
