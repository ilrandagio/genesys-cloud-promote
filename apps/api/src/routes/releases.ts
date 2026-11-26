import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GenesysClient } from '../genesys/client.js';
import { diffPaths } from '../genesys/compare.js';
import { db, schema } from '../lib/db.js';
import type { ReleaseObject } from '../lib/schema.js';
import { getEnvironment, HttpError } from '../lib/repo.js';
import { buildManifest, crossEnvKey, liveContent, objectKey, type Manifest } from '../worker/releases.js';
import { requireAuth, sessionUser } from './auth.js';

const t = schema.releaseTags;
const o = schema.releaseObjects;
const j = schema.jobs;

async function loadTag(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'Rilascio non trovato');
  const [tag] = await db.select().from(t).where(eq(t.id, id));
  if (!tag) throw new HttpError(404, 'Rilascio non trovato');
  return tag;
}

async function manifestOf(tagId: string): Promise<Manifest> {
  return buildManifest(await db.select().from(o).where(eq(o.tagId, tagId)));
}

/** Oggetto del manifest senza il contenuto (che può essere grande) */
const brief = (x: ReleaseObject) => ({
  id: x.id,
  jobId: x.jobId,
  type: x.type,
  tfType: x.tfType,
  targetId: x.targetId,
  name: x.name,
  subtype: x.subtype,
  version: x.info?.version,
  error: x.info?.error,
  comparable: x.content != null,
  capturedAt: x.capturedAt,
});

type CompareStatus = 'same' | 'different' | 'only_tag' | 'only_other' | 'missing_live' | 'not_comparable';

export async function releaseRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** Rilasci (tag), facoltativamente di un solo ambiente target */
  app.get('/api/releases', async (req) => {
    const q = z.object({ targetEnvId: z.string().uuid().optional() }).parse(req.query);
    const rows = await db
      .select({
        id: t.id,
        name: t.name,
        description: t.description,
        targetEnvId: t.targetEnvId,
        targetName: schema.environments.name,
        promotedFromTagId: t.promotedFromTagId,
        createdBy: t.createdBy,
        createdAt: t.createdAt,
        closedAt: t.closedAt,
        closedBy: t.closedBy,
        jobs: sql<number>`(select count(*)::int from jobs where jobs.release_tag_id = ${t.id} and jobs.mode = 'APPLY')`,
        lastActivity: sql<Date | null>`(select max(created_at) from jobs where jobs.release_tag_id = ${t.id})`,
      })
      .from(t)
      .innerJoin(schema.environments, eq(t.targetEnvId, schema.environments.id))
      .where(q.targetEnvId ? eq(t.targetEnvId, q.targetEnvId) : undefined)
      .orderBy(desc(t.createdAt));
    return rows;
  });

  app.post('/api/releases', async (req) => {
    const body = z
      .object({
        name: z.string().trim().min(1, 'Nome obbligatorio').max(100),
        targetEnvId: z.string().uuid(),
        description: z.string().trim().max(2000).optional(),
        promotedFromTagId: z.string().uuid().optional(),
      })
      .parse(req.body);
    const env = await getEnvironment(body.targetEnvId);
    if (!env.allowAsTarget) throw new HttpError(400, `${env.name} non è abilitato come target`);
    const [dup] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.targetEnvId, body.targetEnvId), sql`lower(${t.name}) = lower(${body.name})`));
    if (dup) throw new HttpError(409, `Su ${env.name} esiste già il rilascio "${body.name}"`);
    if (body.promotedFromTagId) await loadTag(body.promotedFromTagId);
    const [row] = await db
      .insert(t)
      .values({
        name: body.name,
        targetEnvId: body.targetEnvId,
        description: body.description || null,
        promotedFromTagId: body.promotedFromTagId ?? null,
        createdBy: sessionUser(req).sub,
      })
      .returning();
    return row;
  });

  /**
   * Nome proposto per il prossimo tag di un ambiente: l'ultimo numero del tag più recente incrementato
   * (R2026.12.2 -> R2026.12.3); senza tag, R<anno>.<mese>.1
   */
  app.get('/api/releases/next-name', async (req) => {
    const q = z.object({ targetEnvId: z.string().uuid() }).parse(req.query);
    const [last] = await db.select({ name: t.name }).from(t).where(eq(t.targetEnvId, q.targetEnvId)).orderBy(desc(t.createdAt)).limit(1);
    const now = new Date();
    if (!last) return { name: `R${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.1` };
    const m = last.name.match(/^(.*?)(\d+)(\D*)$/);
    return { name: m ? `${m[1]}${Number(m[2]) + 1}${m[3]}` : `${last.name}.1` };
  });

  /** Chiude (o riapre) un tag: chiuso non si associa a nuove simulazioni */
  app.post('/api/releases/:id/close', async (req) => {
    const tag = await loadTag((req.params as { id: string }).id);
    const { closed } = z.object({ closed: z.boolean() }).parse(req.body);
    const [row] = await db
      .update(t)
      .set(closed ? { closedAt: new Date(), closedBy: sessionUser(req).sub } : { closedAt: null, closedBy: null })
      .where(eq(t.id, tag.id))
      .returning();
    return row;
  });

  app.patch('/api/releases/:id', async (req) => {
    const tag = await loadTag((req.params as { id: string }).id);
    const body = z.object({ description: z.string().trim().max(2000).optional() }).parse(req.body);
    const [row] = await db.update(t).set({ description: body.description || null }).where(eq(t.id, tag.id)).returning();
    return row;
  });

  /** Eliminabile solo se nessuna simulazione o esecuzione lo usa */
  app.delete('/api/releases/:id', async (req) => {
    const tag = await loadTag((req.params as { id: string }).id);
    const [used] = await db.select({ id: j.id }).from(j).where(eq(j.releaseTagId, tag.id)).limit(1);
    if (used) throw new HttpError(409, 'Il rilascio ha simulazioni o esecuzioni: non si può eliminare');
    await db.delete(t).where(eq(t.id, tag.id));
    return { ok: true };
  });

  /** Dettaglio: esecuzioni del tag e contenuto (ultima versione di ogni oggetto) */
  app.get('/api/releases/:id', async (req) => {
    const tag = await loadTag((req.params as { id: string }).id);
    const env = await getEnvironment(tag.targetEnvId);
    const jobs = await db
      .select({
        id: j.id,
        mode: j.mode,
        status: j.status,
        createdBy: j.createdBy,
        createdAt: j.createdAt,
        finishedAt: j.finishedAt,
        planJobId: j.planJobId,
        rollbackOfJobId: j.rollbackOfJobId,
        appliedResources: j.appliedResources,
        sourceName: schema.environments.name,
      })
      .from(j)
      .innerJoin(schema.environments, eq(j.sourceEnvId, schema.environments.id))
      .where(eq(j.releaseTagId, tag.id))
      .orderBy(asc(j.createdAt));
    const manifest = await manifestOf(tag.id);
    const promotedFrom = tag.promotedFromTagId
      ? await db
          .select({ id: t.id, name: t.name, targetName: schema.environments.name })
          .from(t)
          .innerJoin(schema.environments, eq(t.targetEnvId, schema.environments.id))
          .where(eq(t.id, tag.promotedFromTagId))
          .then((r) => r[0])
      : undefined;
    return {
      ...tag,
      targetName: env.name,
      targetRegion: env.region,
      promotedFrom,
      jobs,
      objects: manifest.entries.map((e) => ({ ...brief(e.object), versions: e.versions })),
      undone: manifest.undone.map(brief),
    };
  });

  /**
   * Confronto del tag con il sistema live del suo ambiente o con un altro tag (stesso ambiente o un altro).
   * Le differenze vanno dall'altro termine al tag: "only_tag" = solo nel tag, "only_other" = solo nell'altro.
   */
  app.get('/api/releases/:id/compare', async (req) => {
    const tag = await loadTag((req.params as { id: string }).id);
    const { with: other } = z.object({ with: z.string() }).parse(req.query);
    const mine = (await manifestOf(tag.id)).entries.map((e) => e.object);
    const rows: {
      key: string;
      status: CompareStatus;
      tag?: ReturnType<typeof brief>;
      other?: ReturnType<typeof brief>;
      diff?: string[];
      liveVersion?: string;
      error?: string;
    }[] = [];

    if (other === 'live') {
      const client = new GenesysClient(await getEnvironment(tag.targetEnvId));
      for (const x of mine) {
        const row = { key: objectKey(x), tag: brief(x) } as (typeof rows)[number];
        if (!x.type || !x.targetId || x.content == null) {
          rows.push({ ...row, status: 'not_comparable' });
          continue;
        }
        try {
          const live = await liveContent(client, x.type as any, x.targetId);
          if (!live) rows.push({ ...row, status: 'missing_live' });
          else {
            const diff = diffPaths(live.content, x.content, '', [], 30);
            rows.push({ ...row, status: diff.length ? 'different' : 'same', diff, liveVersion: live.version });
          }
        } catch (e) {
          rows.push({ ...row, status: 'not_comparable', error: (e as Error).message });
        }
      }
      return { other: { kind: 'live' as const }, rows };
    }

    const otherTag = await loadTag(other);
    const theirs = (await manifestOf(otherTag.id)).entries.map((e) => e.object);
    // Stesso ambiente: per ID; ambienti diversi: per tipo e nome (gli ID cambiano tra org)
    const keyOf = otherTag.targetEnvId === tag.targetEnvId ? objectKey : crossEnvKey;
    const byKey = new Map(theirs.map((x) => [keyOf(x), x]));
    const seen = new Set<string>();
    for (const x of mine) {
      const k = keyOf(x);
      seen.add(k);
      const y = byKey.get(k);
      if (!y) rows.push({ key: k, status: 'only_tag', tag: brief(x) });
      else if (x.content == null || y.content == null) rows.push({ key: k, status: 'not_comparable', tag: brief(x), other: brief(y) });
      else {
        const diff = diffPaths(y.content, x.content, '', [], 30);
        rows.push({ key: k, status: diff.length ? 'different' : 'same', tag: brief(x), other: brief(y), diff });
      }
    }
    for (const y of theirs) if (!seen.has(keyOf(y))) rows.push({ key: keyOf(y), status: 'only_other', other: brief(y) });
    const env = await getEnvironment(otherTag.targetEnvId);
    return { other: { kind: 'tag' as const, id: otherTag.id, name: otherTag.name, targetName: env.name }, rows };
  });

  /** Contenuti per il confronto riga per riga: dall'altro termine (live o versione di un altro tag) al tag */
  app.get('/api/releases/:id/diff', async (req) => {
    const tag = await loadTag((req.params as { id: string }).id);
    const q = z.object({ objectId: z.string().uuid().optional(), otherObjectId: z.string().uuid().optional(), live: z.string().optional() }).parse(req.query);
    const ids = [q.objectId, q.otherObjectId].filter((x): x is string => !!x);
    const found = ids.length ? await db.select().from(o).where(inArray(o.id, ids)) : [];
    const mine = found.find((x) => x.id === q.objectId);
    const theirs = found.find((x) => x.id === q.otherObjectId);
    if (q.objectId && (!mine || mine.tagId !== tag.id)) throw new HttpError(404, 'Oggetto non trovato nel rilascio');
    let other: unknown = null;
    if (q.live === '1' && mine?.type && mine.targetId) {
      const live = await liveContent(new GenesysClient(await getEnvironment(tag.targetEnvId)), mine.type as any, mine.targetId);
      other = live?.content ?? null;
    } else if (theirs) other = theirs.content;
    return { tag: mine?.content ?? null, other };
  });
}
