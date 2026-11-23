import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CATALOG } from '../genesys/catalog.js';
import type { ObjectType, PortItem } from '../genesys/types.js';
import { config } from '../config.js';
import { includeFilter, type TfJson } from './exportConfig.js';
import { tfOrThrow, type TfCreds } from './terraform.js';

/**
 * Esporta da un'org gli oggetti indicati con genesyscloud_tf_export (sola lettura) e restituisce la
 * configurazione JSON e il percorso del file. Mai un export senza filtro: esporterebbe l'intera org.
 * Membri di Queues, Groups e Work Teams non vengono mai esportati.
 */
export async function exportObjects(opts: {
  items: PortItem[];
  /** Filtri aggiuntivi già pronti (tipo::regex), es. tutti gli oggetti di un tipo per il backup */
  filters?: { type?: ObjectType; filter: string }[];
  /** Scrive anche lo state (ID degli oggetti esportati): serve al backup */
  includeState?: boolean;
  /**
   * Solo backup completo: tutta l'org, senza filtri né attributi esclusi (membri e utenti compresi).
   * Mai usato dal porting, che esporta sempre e solo gli oggetti scelti
   */
  wholeOrg?: boolean;
  runnerDir: string;
  exportDir: string;
  creds: TfCreds;
  orgName: string;
  line: (l: string) => void;
  info: (l: string) => void;
}): Promise<{ cfg: TfJson; cfgPath: string }> {
  const { items, filters = [], includeState = false, wholeOrg = false, runnerDir, exportDir, creds, orgName, line, info } = opts;
  if (!wholeOrg && !items.length && !filters.length) throw new Error('Export senza oggetti: rifiutato (esporterebbe l\'intera org)');
  for (const it of items) if (CATALOG[it.type].singleton) throw new Error(`${CATALOG[it.type].label}: oggetto unico per org, non esportabile`);
  const exportedTypes = new Set<ObjectType>([...items.map((i) => i.type), ...filters.flatMap((f) => (f.type ? [f.type] : []))]);

  // Esclusione solo per i tipi esportati: il provider rifiuta l'esclusione di attributi di tipi non esportati
  const excluded = wholeOrg ? [] : [
    ...(exportedTypes.has('queue')
      ? [
          'genesyscloud_routing_queue.members',
          'genesyscloud_routing_queue.groups',
          'genesyscloud_routing_queue.teams',
          'genesyscloud_routing_queue.skill_groups',
        ]
      : []),
    ...(exportedTypes.has('group') ? ['genesyscloud_group.member_ids', 'genesyscloud_group.owner_ids'] : []),
    ...(exportedTypes.has('team') ? ['genesyscloud_team.member_ids'] : []),
  ];

  await mkdir(runnerDir, { recursive: true });
  await mkdir(exportDir, { recursive: true });
  const runner = {
    terraform: {
      required_providers: { genesyscloud: { source: 'mypurecloud/genesyscloud', version: config.GENESYS_PROVIDER_VERSION } },
    },
    provider: { genesyscloud: {} },
    resource: {
      genesyscloud_tf_export: {
        export: {
          // Percorso relativo con "/": su Windows un percorso assoluto (c:\...) viene scambiato
          // dal provider per un URL ("unsupported protocol scheme c") quando scarica script e prompt
          directory: path.relative(runnerDir, exportDir).split(path.sep).join('/'),
          export_format: 'json',
          include_state_file: includeState,
          enable_dependency_resolution: false,
          // Il vecchio esportatore dei flow non scrive i file YAML: lascia il percorso come variabile da
          // compilare a mano (var.genesyscloud_flow_..._filepath) e il plan fallisce con "empty file path"
          use_legacy_architect_flow_exporter: false,
          split_files_by_resource: false,
          ...(wholeOrg ? {} : { include_filter_resources: [...items.map(includeFilter), ...filters.map((f) => f.filter)] }),
          ...(excluded.length ? { exclude_attributes: excluded } : {}),
        },
      },
    },
  };
  await writeFile(path.join(runnerDir, 'main.tf.json'), JSON.stringify(runner, null, 2));
  info(
    `Export da ${orgName} (genesyscloud_tf_export): sola lettura, i file vengono scritti in locale. ` +
      `"Apply complete" qui sotto si riferisce alla sola risorsa di export.`,
  );
  await tfOrThrow(['init', '-no-color', '-input=false'], runnerDir, creds, line);
  await tfOrThrow(['apply', '-no-color', '-auto-approve', '-input=false'], runnerDir, creds, line);

  // Nessun file: nessun oggetto trovato dal filtro. Chi chiama segnala quali oggetti mancano
  const exportFile = (await readdir(exportDir)).find((f) => f.endsWith('.tf.json'));
  if (!exportFile) {
    info(`L'export da ${orgName} non contiene oggetti`);
    return { cfg: { resource: {} }, cfgPath: path.join(exportDir, 'genesyscloud.tf.json') };
  }
  const cfgPath = path.join(exportDir, exportFile);
  return { cfg: JSON.parse(await readFile(cfgPath, 'utf8')) as TfJson, cfgPath };
}
