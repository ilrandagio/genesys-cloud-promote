import { CATALOG } from '../genesys/catalog.js';
import type { PortItem } from '../genesys/types.js';
import type { Job } from '../lib/schema.js';

const fmt = (d?: Date | null) =>
  d ? d.toLocaleString('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'medium' }) : '—';

const ACTION: Record<string, string> = { create: 'creato', update: 'aggiornato', delete: 'cancellato', 'no-op': 'già uguale' };

/** Riga di tabella Markdown con i caratteri speciali protetti */
const row = (cells: (string | number)[]) => `| ${cells.map((c) => String(c).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`;

const typeLabel = (i: PortItem) => CATALOG[i.type]?.label ?? i.type;

/**
 * Note di rilascio di un'esecuzione, in Markdown: chi, quando, da dove a dove, cosa è stato portato e con quale
 * esito, gli avvisi letti all'approvazione e il log completo. Servono per l'audit e per comunicare il rilascio.
 */
export function buildReleaseNotes(input: {
  apply: Job;
  plan?: Job;
  sourceName: string;
  targetName: string;
  rollbackOf?: Job;
}): string {
  const { apply, plan, sourceName, targetName, rollbackOf } = input;
  const summary = plan?.planSummary;
  const applied = new Set(apply.appliedResources ?? []);
  const outcome =
    apply.status === 'SUCCEEDED'
      ? 'Completato'
      : apply.status === 'FAILED'
        ? applied.size
          ? `Interrotto con errore (${applied.size} modifiche applicate prima dell'errore)`
          : 'Non riuscito (nessuna modifica applicata)'
        : 'In corso';

  const out: string[] = [];
  out.push(`# Note di rilascio: ${sourceName} → ${targetName}`, '');
  if (rollbackOf) {
    out.push(
      `> Ripristino: questo rilascio riporta ${targetName} allo stato precedente all'esecuzione ${rollbackOf.id} ` +
        `del ${fmt(rollbackOf.createdAt)}.`,
      '',
    );
  }
  out.push('| | |', '| --- | --- |');
  out.push(row(['Esito', outcome]));
  out.push(row(['Eseguito da', apply.createdBy]));
  out.push(row(['Avviato', fmt(apply.createdAt)]));
  out.push(row(['Terminato', fmt(apply.finishedAt)]));
  if (plan) {
    out.push(row(['Simulazione creata da', `${plan.createdBy} il ${fmt(plan.createdAt)}`]));
    out.push(row(['Approvata da', plan.approvedBy ? `${plan.approvedBy} il ${fmt(plan.approvedAt)}` : 'non richiesta']));
  }
  out.push(row(['Esecuzione', apply.id]));
  if (plan) out.push(row(['Simulazione', plan.id]));
  out.push('');

  if (summary) {
    out.push(
      '## Riepilogo',
      '',
      `${summary.add} oggetti da creare, ${summary.change} da aggiornare` +
        (summary.destroy ? `, ${summary.destroy} da cancellare` : '') +
        (summary.unchanged?.length ? `, ${summary.unchanged.length} già uguali sul target` : '') +
        '.',
      '',
    );
  }

  const ported = apply.items.filter((i) => i.action === 'port');
  if (ported.length) {
    out.push('## Oggetti portati', '', row(['Tipo', 'Nome', "Sul target all'analisi"]), row(['---', '---', '---']));
    const STATUS: Record<string, string> = { missing: 'mancante', same: 'uguale', different: 'diverso', present: 'presente' };
    for (const i of [...ported].sort((a, b) => typeLabel(a).localeCompare(typeLabel(b)) || a.name.localeCompare(b.name))) {
      out.push(row([typeLabel(i), i.name, STATUS[i.targetStatus] ?? i.targetStatus]));
    }
    out.push('');
  }

  if (plan?.terraformTypes?.length) {
    out.push(
      '## Tipi Terraform portati interi',
      '',
      'Tutti gli oggetti di questi tipi, abbinati al target per nome (dettaglio nelle modifiche qui sotto):',
      '',
      plan.terraformTypes.map((t) => `- \`${t}\``).join('\n'),
      '',
    );
  }

  const reused = apply.items.filter((i) => i.action === 'reuse');
  if (reused.length) {
    out.push(
      '## Oggetti del target usati (non modificati)',
      '',
      reused.map((i) => `- ${typeLabel(i)} "${i.name}"`).join('\n'),
      '',
    );
  }

  if (summary?.changes.length) {
    out.push('## Modifiche sul target', '', row(['Risorsa', 'Modifica', 'Applicata']), row(['---', '---', '---']));
    for (const c of summary.changes) {
      const action = c.actions.includes('delete') && c.actions.includes('create') ? 'ricreato' : c.actions.map((a) => ACTION[a] ?? a).join(', ');
      out.push(row([`\`${c.address}\``, action, applied.has(c.address) ? 'sì' : 'no']));
    }
    out.push('');
  }

  if (summary?.warnings?.length) {
    out.push('## Avvisi letti prima dell\'approvazione', '', summary.warnings.map((w) => `- ${w}`).join('\n'), '');
  }

  out.push('## Log dell\'esecuzione', '', '```text', apply.log.trimEnd(), '```', '');
  return out.join('\n');
}
