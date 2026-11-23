import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { TERRAFORM_TYPES } from '../genesys/terraformTypes.js';
import type { Environment } from '../lib/schema.js';
import type { TfJson } from './exportConfig.js';
import { exportObjects } from './exporter.js';
import type { TfCreds } from './terraform.js';

/**
 * Motore generico per le risorse del provider fuori dal catalogo (Disaster Recovery, tipi interi).
 * Non conosce le API Genesys di ogni tipo: si affida all'export di Terraform su entrambe le org.
 * - stesso exporter, stesse regole per le etichette: stesso nome sul sorgente e sul target = stessa etichetta;
 * - le risorse presenti sul target vengono importate (aggiornamento), le altre create;
 * - i riferimenti tra risorse esportate insieme sono già riferimenti Terraform; gli ID sorgente degli oggetti
 *   generici diventano riferimenti nello stesso job; quelli rimasti senza corrispondenza vengono segnalati.
 */

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

interface StateFile {
  resources?: { mode: string; type: string; name: string; instances?: { attributes?: { id?: string } }[] }[];
}

/** ID delle risorse dei tipi indicati, dallo state scritto dall'export (indirizzo → ID) */
export async function stateIds(dir: string, types: Set<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let state: StateFile;
  try {
    state = JSON.parse(await readFile(path.join(dir, 'terraform.tfstate'), 'utf8'));
  } catch {
    return out;
  }
  for (const r of state.resources ?? []) {
    const id = r.instances?.[0]?.attributes?.id;
    if (r.mode === 'managed' && types.has(r.type) && id) out.set(`${r.type}.${r.name}`, id);
  }
  return out;
}

export const resourceExists = (cfg: TfJson, addr: string) => {
  const [type, ...rest] = addr.split('.');
  return !!cfg.resource?.[type]?.[rest.join('.')];
};

/**
 * Export dal target degli stessi tipi generici (sola lettura) e abbinamento per etichetta. Restituisce gli
 * import da fare (risorse già presenti sul target) e gli avvisi per i tipi da verificare con attenzione.
 */
export async function matchGenericOnTarget(opts: {
  cfg: TfJson;
  genericTypes: string[];
  sourceIds: Map<string, string>;
  targetEnv: Environment;
  workDir: string;
  creds: TfCreds;
  log: { info: (l: string) => void; line: (l: string) => void };
}): Promise<{ imports: { addr: string; id: string }[]; warnings: string[] }> {
  const { cfg, genericTypes, targetEnv, workDir, creds, log } = opts;
  const dir = path.join(workDir, 'target-generic');
  log.info(`Tipi generici: export da ${targetEnv.name} (sola lettura) per riconoscere gli oggetti già presenti`);
  await exportObjects({
    items: [],
    filters: genericTypes.map((t) => ({ filter: `${t}::.*` })),
    includeState: true,
    runnerDir: path.join(dir, 'runner'),
    exportDir: path.join(dir, 'export'),
    creds,
    orgName: targetEnv.name,
    line: log.line,
    info: log.info,
  });
  const onTarget = await stateIds(path.join(dir, 'export'), new Set(genericTypes));

  const imports: { addr: string; id: string }[] = [];
  const summary: string[] = [];
  for (const type of genericTypes) {
    const labels = Object.keys(cfg.resource?.[type] ?? {});
    let existing = 0;
    for (const label of labels) {
      const id = onTarget.get(`${type}.${label}`);
      if (id) {
        imports.push({ addr: `${type}.${label}`, id });
        existing++;
      }
    }
    summary.push(`${type}: ${labels.length} (${existing} già sul target, ${labels.length - existing} nuovi)`);
  }
  log.info(`Tipi generici: ${summary.join('; ')}`);

  const warnings: string[] = [];
  const present = TERRAFORM_TYPES.filter((t) => genericTypes.includes(t.tfType) && Object.keys(cfg.resource?.[t.tfType] ?? {}).length);
  const flagged = (flag: string) => present.filter((t) => t.flags.includes(flag as never)).map((t) => t.label);
  const env = flagged('env');
  if (env.length) {
    warnings.push(
      `Tipi con valori legati all'ambiente, copiati così come sono dal sorgente (numeri, domini, indirizzi, infrastruttura): ${env.join(', ')}. Verificare che sul target siano corretti.`,
    );
  }
  const security = [...flagged('security'), ...flagged('users')];
  if (security.length) warnings.push(`Tipi di sicurezza, accesso o utenti portati: ${security.join(', ')}.`);
  const data = flagged('data');
  if (data.length) warnings.push(`Tipi che contengono dati più che configurazione: ${data.join(', ')}.`);
  if (genericTypes.length) {
    warnings.push(
      `Tipi Terraform generici (${genericTypes.length}): abbinati al target per nome, senza analisi delle dipendenze né confronto dettagliato; ` +
        'il ripristino automatico non li riporta allo stato precedente.',
    );
  }
  return { imports, warnings };
}

/**
 * Variabili dell'export senza valore: di solito segreti che il provider non può esportare (credenziali,
 * chiavi). Senza un valore il piano non si calcola: meglio fermarsi con l'elenco.
 */
export async function checkExportVariables(cfg: TfJson, dir: string) {
  const vars = Object.entries((cfg as any).variable ?? {}) as [string, { default?: unknown }][];
  const noDefault = vars.filter(([, v]) => v?.default === undefined).map(([k]) => k);
  if (!noDefault.length) return;
  const provided = new Set<string>();
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    if (!/\.tfvars(\.json)?$/.test(f)) continue;
    const text = await readFile(path.join(dir, f), 'utf8');
    if (f.endsWith('.json')) Object.keys(JSON.parse(text)).forEach((k) => provided.add(k));
    else for (const m of text.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) provided.add(m[1]);
  }
  const missing = noDefault.filter((v) => !provided.has(v));
  if (missing.length) {
    throw new Error(
      `L'export richiede valori che il provider non può esportare (di solito segreti, per esempio credenziali): ${missing.join(', ')}. ` +
        'Togliere il tipo che li contiene dal Disaster Recovery e configurarlo a mano sul target.',
    );
  }
}

/** ID rimasti nelle risorse generiche dopo la rimappatura che non sono ID noti del target */
export function unresolvedGenericIds(
  cfg: TfJson,
  types: Set<string>,
  targetIds: Map<string, string>,
  imports: { id: string }[],
): string[] {
  const known = new Set([...targetIds.values(), ...imports.map((i) => i.id)].map((v) => v.toLowerCase()));
  const found: string[] = [];
  for (const type of types) {
    for (const [label, attrs] of Object.entries(cfg.resource?.[type] ?? {})) {
      const ids = new Set((JSON.stringify(attrs).match(GUID) ?? []).map((g) => g.toLowerCase()));
      for (const id of ids) if (!known.has(id)) found.push(`${type}.${label}: ${id}`);
    }
  }
  if (!found.length) return [];
  return [
    `ID nelle risorse generiche senza corrispondenza sul target (${found.length}): probabilmente oggetti del sorgente non portati. ` +
      `Da verificare prima di approvare: ${found.slice(0, 15).join('; ')}${found.length > 15 ? '…' : ''}`,
  ];
}
