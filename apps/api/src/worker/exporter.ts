import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CATALOG } from '../genesys/catalog.js';
import type { PortItem } from '../genesys/types.js';
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
  runnerDir: string;
  exportDir: string;
  creds: TfCreds;
  orgName: string;
  line: (l: string) => void;
  info: (l: string) => void;
}): Promise<{ cfg: TfJson; cfgPath: string }> {
  const { items, runnerDir, exportDir, creds, orgName, line, info } = opts;
  if (!items.length) throw new Error('Export senza oggetti: rifiutato (esporterebbe l\'intera org)');
  for (const it of items) if (CATALOG[it.type].singleton) throw new Error(`${CATALOG[it.type].label}: oggetto unico per org, non esportabile`);

  // Esclusione solo per i tipi esportati: il provider rifiuta l'esclusione di attributi di tipi non esportati
  const excluded = [
    ...(items.some((i) => i.type === 'queue')
      ? [
          'genesyscloud_routing_queue.members',
          'genesyscloud_routing_queue.groups',
          'genesyscloud_routing_queue.teams',
          'genesyscloud_routing_queue.skill_groups',
        ]
      : []),
    ...(items.some((i) => i.type === 'group') ? ['genesyscloud_group.member_ids', 'genesyscloud_group.owner_ids'] : []),
    ...(items.some((i) => i.type === 'team') ? ['genesyscloud_team.member_ids'] : []),
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
          include_state_file: false,
          enable_dependency_resolution: false,
          // Il vecchio esportatore dei flow non scrive i file YAML: lascia il percorso come variabile da
          // compilare a mano (var.genesyscloud_flow_..._filepath) e il plan fallisce con "empty file path"
          use_legacy_architect_flow_exporter: false,
          split_files_by_resource: false,
          include_filter_resources: items.map(includeFilter),
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

  const exportFile = (await readdir(exportDir)).find((f) => f.endsWith('.tf.json'));
  if (!exportFile) throw new Error('Export senza file .tf.json');
  const cfgPath = path.join(exportDir, exportFile);
  return { cfg: JSON.parse(await readFile(cfgPath, 'utf8')) as TfJson, cfgPath };
}
