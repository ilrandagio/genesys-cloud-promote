import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';

export const QUEUE_NAME = 'porting';

export function redisConnection() {
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
}

export const portingQueue = new Queue<{ jobId: string }>(QUEUE_NAME, { connection: redisConnection() });
