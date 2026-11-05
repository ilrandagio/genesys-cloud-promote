import { config } from '../config.js';

export const QUEUE_NAME = 'porting';

let localChain: Promise<void> = Promise.resolve();

/**
 * Accoda un job di porting.
 * - Con REDIS_URL: BullMQ, eseguito dal processo worker separato.
 * - Senza: coda interna al processo dell'API, un job alla volta.
 */
export async function enqueuePorting(jobId: string): Promise<void> {
  if (config.REDIS_URL) {
    const { Queue } = await import('bullmq');
    const { Redis } = await import('ioredis');
    const queue = new Queue<{ jobId: string }>(QUEUE_NAME, {
      connection: new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
    });
    await queue.add('port', { jobId }, { jobId, attempts: 1 });
    await queue.close();
    return;
  }
  const { runPortingJob } = await import('../worker/porting.js');
  localChain = localChain.then(() => runPortingJob(jobId)).catch((e) => console.error(`Job ${jobId} fallito`, e));
}

/** Attende la fine del job in corso nella coda interna (per una chiusura ordinata) */
export function localQueueIdle(): Promise<void> {
  return localChain;
}
