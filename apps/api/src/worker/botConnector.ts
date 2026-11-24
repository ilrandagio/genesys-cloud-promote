import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMap, isScalar, parseDocument, visit, type Pair, type YAMLMap } from 'yaml';
import type { BotMapping } from '../lib/schema.js';
import type { PortItem } from '../genesys/types.js';
import type { TfJson } from './exportConfig.js';

type Log = (msg: string) => void;

interface Reader {
  get<T = any>(path: string): Promise<T>;
  listAll<T = any>(path: string, extraQuery?: string): Promise<T[]>;
}

/** Riferimento a un bot nello YAML di un flow (azioni Call Bot Connector / Call Digital Bot Connector) */
export interface BotRef {
  flow: string;
  integration: string;
  bot: string;
  version: string;
  /** Riferimento cambiato da una regola dell'ambiente target */
  mappedFrom?: { integration: string; bot: string; version: string };
}

const same = (a?: string, b?: string) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
const keyText = (p: Pair) => (isScalar(p.key) ? String(p.key.value) : String(p.key));

/** Imposta il testo di una chiave mantenendo il tipo (le versioni numeriche restano numeri) */
function setKey(p: Pair, value: string) {
  if (!isScalar(p.key)) return;
  p.key.value = typeof p.key.value === 'number' && /^\d+$/.test(value) ? Number(value) : value;
}

/** Regola che si applica a un riferimento (la più specifica: integration e versione indicate battono quelle vuote) */
export function findMapping(rules: BotMapping[], integration: string, bot: string, version: string): BotMapping | undefined {
  const candidates = rules.filter(
    (r) =>
      same(r.sourceBot, bot) &&
      (!r.integration?.trim() || same(r.integration, integration)) &&
      (!r.sourceVersion?.trim() || same(r.sourceVersion, version)),
  );
  const score = (r: BotMapping) => (r.integration?.trim() ? 2 : 0) + (r.sourceVersion?.trim() ? 1 : 0);
  return candidates.sort((a, b) => score(b) - score(a))[0];
}

/**
 * Nel YAML di un flow il bot di un'azione Bot Connector è scritto come chiavi annidate:
 *   botIntegration: { <integration>: { <bot>: { <versione>: { intents, outputs... } } } }
 * Applica le regole dell'ambiente target (nome dell'integration, del bot e versione) e restituisce i riferimenti.
 */
export function rewriteBotRefs(text: string, flow: string, rules: BotMapping[]): { text: string; refs: BotRef[] } {
  const doc = parseDocument(text);
  const refs: BotRef[] = [];
  let changed = false;
  visit(doc, {
    Pair(_, pair) {
      if (!isScalar(pair.key) || pair.key.value !== 'botIntegration' || !isMap(pair.value)) return;
      for (const intPair of (pair.value as YAMLMap).items) {
        if (!isMap(intPair.value)) continue;
        const integration = keyText(intPair);
        for (const botPair of (intPair.value as YAMLMap).items) {
          if (!isMap(botPair.value)) continue;
          const bot = keyText(botPair);
          const versions = (botPair.value as YAMLMap).items;
          for (const verPair of versions.length ? versions : [undefined]) {
            const version = verPair ? keyText(verPair) : '';
            const rule = findMapping(rules, integration, bot, version);
            const ref: BotRef = { flow, integration, bot, version };
            if (rule) {
              const next = {
                integration: rule.targetIntegration?.trim() || integration,
                bot: rule.targetBot?.trim() || bot,
                version: rule.targetVersion?.trim() || version,
              };
              if (next.integration !== integration || next.bot !== bot || next.version !== version) {
                ref.mappedFrom = { integration, bot, version };
                Object.assign(ref, next);
              }
            }
            refs.push(ref);
          }
        }
      }
      // Rinomina dopo la lettura: le chiavi condivise (stesso bot, più versioni) cambiano una volta sola
      for (const intPair of (pair.value as YAMLMap).items) {
        if (!isMap(intPair.value)) continue;
        const integration = keyText(intPair);
        let newIntegration = integration;
        for (const botPair of (intPair.value as YAMLMap).items) {
          if (!isMap(botPair.value)) continue;
          const bot = keyText(botPair);
          let newBot = bot;
          for (const verPair of (botPair.value as YAMLMap).items) {
            const version = keyText(verPair);
            const rule = findMapping(rules, integration, bot, version);
            if (!rule) continue;
            if (rule.targetVersion?.trim() && rule.targetVersion.trim() !== version) {
              setKey(verPair, rule.targetVersion.trim());
              changed = true;
            }
            if (rule.targetBot?.trim()) newBot = rule.targetBot.trim();
            if (rule.targetIntegration?.trim()) newIntegration = rule.targetIntegration.trim();
          }
          if (newBot !== bot) {
            setKey(botPair, newBot);
            changed = true;
          }
        }
        if (newIntegration !== integration) {
          setKey(intPair, newIntegration);
          changed = true;
        }
      }
    },
  });
  return { text: changed ? doc.toString({ lineWidth: 0 }) : text, refs };
}

/** Applica le regole Bot Connector ai file YAML dei flow da portare; restituisce tutti i riferimenti trovati */
export async function applyBotMappings(
  cfg: TfJson,
  addresses: Map<PortItem, string>,
  baseDir: string,
  rules: BotMapping[],
  log: Log,
): Promise<BotRef[]> {
  const all: BotRef[] = [];
  for (const [it, addr] of addresses) {
    if (it.type !== 'flow' || it.action !== 'port') continue;
    const attrs = cfg.resource?.genesyscloud_flow?.[addr.slice('genesyscloud_flow.'.length)];
    const filepath = attrs?.filepath;
    if (typeof filepath !== 'string' || filepath.includes('${')) continue;
    const abs = path.resolve(baseDir, ...filepath.split(/[\\/]+/));
    let text: string;
    try {
      text = await readFile(abs, 'utf8');
    } catch {
      continue; // lo segnala il controllo dei file esportati
    }
    if (!text.includes('botIntegration')) continue;
    const out = rewriteBotRefs(text, it.name, rules);
    if (out.text !== text) {
      await writeFile(abs, out.text);
      if (attrs) delete attrs.file_content_hash;
    }
    for (const r of out.refs) {
      log(
        r.mappedFrom
          ? `Flow "${r.flow}": Bot Connector ${r.mappedFrom.bot} v${r.mappedFrom.version} -> ${r.bot} v${r.version}` +
              (r.mappedFrom.integration !== r.integration ? ` (integration ${r.integration})` : '')
          : `Flow "${r.flow}": Bot Connector ${r.bot} v${r.version} (integration ${r.integration}), invariato`,
      );
    }
    all.push(...out.refs);
  }
  return all;
}

/** Bots di un'integration Bot Connector: nome -> versioni */
async function botsOf(client: Reader, integrationId: string): Promise<Map<string, { name: string; versions: string[] }>> {
  const res = await client.get(`/api/v2/integrations/botconnector/${encodeURIComponent(integrationId)}/bots`);
  const list: any[] = res?.chatBots ?? res?.entities ?? (Array.isArray(res) ? res : []);
  return new Map(
    list.map((b) => [
      String(b.name ?? '').toLowerCase(),
      { name: String(b.name ?? ''), versions: (b.versions ?? []).map((v: any) => String(v?.version ?? v)) },
    ]),
  );
}

/** Integrations Bot Connector dell'org con i loro bot (per la pagina Ambienti) */
export async function listBotConnectors(client: Reader) {
  const integrations = (await client.listAll<any>('/api/v2/integrations')).filter((i) =>
    /bot-?connector/i.test(String(i.integrationType?.id ?? '')),
  );
  const out: { integration: string; bots: { name: string; versions: string[] }[]; error?: string }[] = [];
  for (const i of integrations) {
    try {
      out.push({ integration: i.name, bots: [...(await botsOf(client, i.id)).values()].sort((a, b) => a.name.localeCompare(b.name)) });
    } catch (e) {
      out.push({ integration: i.name, bots: [], error: (e as Error).message });
    }
  }
  return out;
}

/**
 * Verifica sul target che integration, bot e versione citati dai flow esistano: altrimenti la pubblicazione
 * del flow fallirebbe in esecuzione. Lista dei bot non leggibile: avviso, il controllo è saltato.
 */
export async function checkBotRefs(refs: BotRef[], target: Reader, log: Log): Promise<string[]> {
  if (!refs.length) return [];
  let integrations: any[];
  try {
    integrations = await target.listAll<any>('/api/v2/integrations');
  } catch (e) {
    const w = `Integrations del target non leggibili, controllo dei Bot Connector saltato: ${(e as Error).message}`;
    log(w);
    return [w];
  }
  const missing: string[] = [];
  const warnings: string[] = [];
  const cache = new Map<string, Map<string, { name: string; versions: string[] }> | Error>();
  const seen = new Set<string>();
  for (const r of refs) {
    const key = `${r.flow}|${r.integration}|${r.bot}|${r.version}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const where = `Flow "${r.flow}": bot "${r.bot}" versione "${r.version}"`;
    const integration = integrations.find((i) => same(i.name, r.integration));
    if (!integration) {
      missing.push(`${where}: integration "${r.integration}" assente sul target`);
      continue;
    }
    if (!cache.has(integration.id)) {
      cache.set(integration.id, await botsOf(target, integration.id).catch((e) => e as Error));
    }
    const bots = cache.get(integration.id)!;
    if (bots instanceof Error) {
      warnings.push(`${where}: bot dell'integration "${r.integration}" non leggibili sul target, controllo saltato (${bots.message})`);
      continue;
    }
    if (!bots.size) {
      warnings.push(`${where}: nessun bot letto dall'integration "${r.integration}" sul target, controllo saltato`);
      continue;
    }
    const bot = bots.get(r.bot.toLowerCase());
    if (!bot) {
      const names = [...bots.values()].map((b) => b.name);
      missing.push(`${where}: bot assente sul target${names.length ? ` (disponibili: ${names.slice(0, 10).join(', ')})` : ''}`);
    } else if (bot.versions.length && !bot.versions.some((v) => same(v, r.version))) {
      missing.push(`${where}: versione assente sul target (disponibili: ${bot.versions.join(', ')})`);
    }
  }
  warnings.forEach(log);
  if (missing.length) {
    throw new Error(
      `Bot Connector citati dai Flows non disponibili sul target (la pubblicazione fallirebbe): ${missing.join(' · ')}. ` +
        `Impostare la sostituzione di bot e versione nella pagina Ambienti, sull'ambiente target (pulsante "Bot Connector"), ` +
        `poi rifare la simulazione.`,
    );
  }
  log(`Bot Connector dei Flows verificati sul target: ${seen.size - warnings.length}`);
  return warnings;
}
