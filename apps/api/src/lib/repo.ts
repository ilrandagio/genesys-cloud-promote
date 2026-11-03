import { eq } from 'drizzle-orm';
import { db, schema } from './db.js';

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export async function getEnvironment(id: string) {
  const [env] = await db.select().from(schema.environments).where(eq(schema.environments.id, id));
  if (!env) throw new HttpError(404, `Ambiente ${id} non trovato`);
  return env;
}
