import { Worker } from 'bullmq';
import { QUEUE_NAME, redisConnection } from '../lib/queue.js';
import { runPortingJob } from './porting.js';

/** Un job alla volta: evita apply concorrenti sullo stesso target */
const worker = new Worker<{ jobId: string }>(
  QUEUE_NAME,
  async (job) => {
    await runPortingJob(job.data.jobId);
  },
  { connection: redisConnection(), concurrency: 1 },
);

worker.on('ready', () => console.log('Worker porting pronto'));
worker.on('failed', (job, err) => console.error(`Job ${job?.id} fallito`, err));
