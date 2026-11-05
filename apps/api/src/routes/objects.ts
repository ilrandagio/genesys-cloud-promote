import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CATALOG, listObjects } from '../genesys/catalog.js';
import { GenesysClient } from '../genesys/client.js';
import { TargetComparer } from '../genesys/compare.js';
import { buildDependencyTree, lazyIdIndex } from '../genesys/dependencies.js';
import { OBJECT_TYPES, toDivision, type DependencyNode, type NamedRef, type ObjectType } from '../genesys/types.js';
import { getEnvironment } from '../lib/repo.js';
import { requireAuth } from './auth.js';

async function clientFor(envId: string) {
  return new GenesysClient(await getEnvironment(envId));
}

export async function objectRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/object-types', async () =>
    OBJECT_TYPES.map((t) => ({ type: t, label: CATALOG[t].label, group: CATALOG[t].group })),
  );

  /** Elenco degli oggetti di un tipo su un ambiente */
  app.get('/api/environments/:envId/objects/:type', async (req) => {
    const { envId, type } = z
      .object({ envId: z.string(), type: z.enum(OBJECT_TYPES) })
      .parse(req.params);
    const client = await clientFor(envId);
    const items = await listObjects(client, type as ObjectType);
    return items
      .map((o: any) => ({
        type,
        id: o.id,
        name: o.name,
        subtype: type === 'flow' ? o.type : undefined,
        description: o.description ?? '',
        division: toDivision(o.division)?.name,
        published: type === 'flow' ? Boolean(o.publishedVersion) : undefined,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  /**
   * Diagnostica: contenuto grezzo dell'oggetto sul sorgente, cioè il testo in cui l'analisi cerca i riferimenti
   * (flow: latestconfiguration; script: JSON esportato; altri tipi: dettaglio).
   */
  app.get('/api/environments/:envId/objects/:type/:id/raw', async (req, reply) => {
    const { envId, type, id } = z
      .object({ envId: z.string(), type: z.enum(OBJECT_TYPES), id: z.string() })
      .parse(req.params);
    const client = await clientFor(envId);
    const content =
      type === 'flow'
        ? await client.get(`/api/v2/flows/${encodeURIComponent(id)}/latestconfiguration`)
        : type === 'script'
          ? await client.exportScript(id)
          : await client.get(CATALOG[type as ObjectType].getPath.replace('{id}', encodeURIComponent(id)));
    return reply.header('Content-Type', 'application/json; charset=utf-8').send(JSON.stringify(content, null, 2));
  });

  /** Sites ed Edge Groups di un ambiente: tra questi si scelgono quelli da usare nelle Campaign portate */
  app.get('/api/environments/:envId/telephony', async (req) => {
    const { envId } = z.object({ envId: z.string() }).parse(req.params);
    const client = await clientFor(envId);
    const named = (list: any[]): NamedRef[] =>
      list.map((o) => ({ id: o.id, name: o.name })).sort((a, b) => a.name.localeCompare(b.name));
    const [sites, edgeGroups] = await Promise.all([
      client.listAll('/api/v2/telephony/providers/edges/sites'),
      client.listAll('/api/v2/telephony/providers/edges/edgegroups'),
    ]);
    return { sites: named(sites), edgeGroups: named(edgeGroups) };
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
    const idIndex = lazyIdIndex(source);
    for (const obj of body.objects) {
      const tree = await buildDependencyTree(source, obj, { includeDivisions: body.includeDivisions, idIndex });
      await comparer.annotate(tree);
      trees.push(tree);
    }

    // Campaign: Site ed Edge Group del sorgente, da sostituire con quelli scelti sul target
    const campaigns = new Map<string, DependencyNode[]>();
    const collect = (n: DependencyNode) => {
      if (n.type === 'campaign' && n.supported) campaigns.set(n.id, [...(campaigns.get(n.id) ?? []), n]);
      n.children.forEach(collect);
    };
    trees.forEach(collect);
    for (const [id, nodes] of campaigns) {
      try {
        const c = await source.get(CATALOG.campaign.getPath.replace('{id}', encodeURIComponent(id)));
        const ref = (r: any): NamedRef | undefined => (r?.id ? { id: r.id, name: r.name ?? r.id } : undefined);
        const telephony = { site: ref(c.site), edgeGroup: ref(c.edgeGroup) };
        if (telephony.site || telephony.edgeGroup) nodes.forEach((n) => (n.telephony = telephony));
      } catch {
        // dettaglio non leggibile: l'errore è già sul nodo
      }
    }
    const built = idIndex.peek();
    const unreadable = built ? (await built).unreadable : [];
    const warnings = unreadable.length
      ? [
          `Tipi di oggetto non leggibili dal client OAuth del sorgente: ${unreadable.join(', ')}. ` +
            `I riferimenti a questi oggetti in flow e script non possono essere riconosciuti.`,
        ]
      : [];
    return { trees, warnings };
  });
}
