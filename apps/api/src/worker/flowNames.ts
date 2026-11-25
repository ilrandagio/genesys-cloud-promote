import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isScalar, parseDocument, visit } from 'yaml';
import { CATALOG, listObjects } from '../genesys/catalog.js';
import type { PortItem } from '../genesys/types.js';
import type { TfJson } from './exportConfig.js';

type Log = (msg: string) => void;

/** Nomi uguali per Genesys: senza spazi all'inizio e alla fine, maiuscole indifferenti */
export const sameName = (a?: string, b?: string) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/**
 * Nomi esatti sul target degli oggetti già presenti (con targetId) che sul sorgente si scrivono in modo diverso,
 * per esempio con uno spazio finale ("Schedule X " sul sorgente, "Schedule X" sul target) o con maiuscole diverse.
 * I Flows citano gli oggetti per nome esatto: senza correzione la pubblicazione fallisce con
 * "could not find the 'schedule group' by name".
 */
export async function targetNameFixes(
  items: PortItem[],
  target: Parameters<typeof listObjects>[0],
  log: Log,
): Promise<Map<string, string>> {
  const fixes = new Map<string, string>();
  const byType = new Map<string, Map<string, string>>();
  for (const it of items) {
    if (!it.targetId || CATALOG[it.type].singleton) continue;
    if (!byType.has(it.type)) {
      const list = await listObjects(target, it.type).catch(() => [] as any[]);
      byType.set(it.type, new Map(list.map((o: any) => [String(o.id).toLowerCase(), String(o.name ?? '')])));
    }
    const name = byType.get(it.type)!.get(it.targetId.toLowerCase());
    if (name && name !== it.name && sameName(name, it.name)) {
      fixes.set(it.name, name);
      log(`${CATALOG[it.type].label} "${it.name}": sul target si chiama "${name}", riferimenti dei Flows corretti`);
    }
  }
  return fixes;
}

/** Sostituisce nel YAML di un flow i nomi (chiavi e valori) che sul target si scrivono diversamente */
export function rewriteFlowNames(text: string, fixes: Map<string, string>): string {
  if (!fixes.size) return text;
  const doc = parseDocument(text);
  let changed = false;
  visit(doc, {
    Scalar(_, node) {
      if (!isScalar(node) || typeof node.value !== 'string') return;
      const next = fixes.get(node.value);
      if (next !== undefined) {
        node.value = next;
        changed = true;
      }
    },
  });
  return changed ? doc.toString({ lineWidth: 0 }) : text;
}

/** Applica le correzioni dei nomi ai file YAML dei Flows da portare */
export async function applyFlowNameFixes(
  cfg: TfJson,
  addresses: Map<PortItem, string>,
  baseDir: string,
  fixes: Map<string, string>,
): Promise<number> {
  if (!fixes.size) return 0;
  let files = 0;
  for (const [it, addr] of addresses) {
    if (it.type !== 'flow' || it.action !== 'port') continue;
    const attrs = cfg.resource?.genesyscloud_flow?.[addr.slice('genesyscloud_flow.'.length)];
    const filepath = attrs?.filepath;
    if (typeof filepath !== 'string' || filepath.includes('${')) continue;
    const abs = path.resolve(baseDir, ...filepath.split(/[\\/]+/));
    const text = await readFile(abs, 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    const next = rewriteFlowNames(text, fixes);
    if (next !== text) {
      await writeFile(abs, next);
      if (attrs) delete attrs.file_content_hash;
      files++;
    }
  }
  return files;
}
