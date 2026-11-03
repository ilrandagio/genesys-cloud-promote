import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CATALOG } from '../genesys/catalog.js';
import { GenesysClient } from '../genesys/client.js';
import { TargetComparer } from '../genesys/compare.js';
import { buildDependencyTree } from '../genesys/dependencies.js';
import { OBJECT_TYPES, type ObjectType } from '../genesys/types.js';
import { getEnvironment } from '../lib/repo.js';
import { requireAuth } from './auth.js';

async function clientFor(envId: string) {
  return new GenesysClient(await getEnvironment(envId));
}

export async function objectRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/object-types', async () =>
    OBJECT_TYPES.map((t) => ({ type: t, label: CATALOG[t].label })),
  );

  /** Elenco degli oggetti di un tipo su un ambiente */
  app.get('/api/environments/:envId/objects/:type', async (req) => {
    const { envId, type } = z
      .object({ envId: z.string(), type: z.enum(OBJECT_TYPES) })
      .parse(req.params);
    const client = await clientFor(envId);
    const items = await client.listAll(CATALOG[type as ObjectType].listPath);
    return items
      .map((o: any) => ({
        type,
        id: o.id,
        name: o.name,
        subtype: type === 'flow' ? o.type : undefined,
        description: o.description ?? '',
        division: o.division?.name,
        published: type === 'flow' ? Boolean(o.publishedVersion) : undefined,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  /**
   * Analisi: per ogni oggetto selezionato costruisce l'albero delle dipendenze sul sorgente
   * e marca ogni nodo con lo stato sul target.
   */
  app.post('/api/analyze', async (req) => {
    const body = z
      .object({
        sourceEnvId: z.string(),
        targetEnvId: z.string(),
        objects: z
          .array(z.object({ type: z.enum(OBJECT_TYPES), id: z.string(), name: z.string(), subtype: z.string().optional() }))
          .min(1),
        /// Divisioni come nodi dell'albero (con azione propria). Disattivato di default.
        includeDivisions: z.boolean().default(false),
      })
      .parse(req.body);

    const [source, target] = await Promise.all([clientFor(body.sourceEnvId), clientFor(body.targetEnvId)]);
    const comparer = new TargetComparer(source, target);

    const trees = [];
    for (const obj of body.objects) {
      const tree = await buildDependencyTree(source, obj, { includeDivisions: body.includeDivisions });
      await comparer.annotate(tree);
      trees.push(tree);
    }
    return { trees };
  });
}
