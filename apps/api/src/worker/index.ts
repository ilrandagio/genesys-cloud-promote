import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { QUEUE_NAME } from '../lib/queue.js';
import { runPortingJob } from './porting.js';

if (!config.REDIS_URL) {
  console.log('REDIS_URL non impostato: i job vengono eseguiti dall\'API (modalità locale), il worker separato non serve.');
  process.exit(0);
}

/** Un job alla volta: evita apply concorrenti sullo stesso target */
const worker = new Worker<{ jobId: string }>(
  QUEUE_NAME,
  async (job) => {
    await runPortingJob(job.data.jobId);
  },
  { connection: new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }), concurrency: 1 },
);

worker.on('ready', () => console.log('Worker porting pronto'));
worker.on('failed', (job, err) => console.error(`Job ${job?.id} fallito`, err));
