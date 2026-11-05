import type { PlanSummary } from '../lib/schema.js';

/** Sottoinsieme di "terraform show -json <planfile>" che serve qui */
export interface PlanJson {
  resource_changes?: {
    address: string;
    change: { actions: string[]; before?: unknown; after?: unknown; after_unknown?: unknown };
  }[];
}

const isReplace = (a: string[]) => a.includes('delete') && a.includes('create');

export function summarize(plan: PlanJson): PlanSummary {
  const summary: PlanSummary = { add: 0, change: 0, destroy: 0, replace: 0, changes: [], unchanged: [] };
  for (const rc of plan.resource_changes ?? []) {
    const actions = rc.change.actions;
    if (actions.every((a) => a === 'no-op' || a === 'read')) {
      // Oggetto scelto ma già identico sul target: va mostrato, altrimenti sembra sparito dal plan
      if (actions.includes('no-op')) summary.unchanged!.push(rc.address);
      continue;
    }
    if (isReplace(actions)) summary.replace++;
    else if (actions.includes('create')) summary.add++;
    else if (actions.includes('update')) summary.change++;
    else if (actions.includes('delete')) summary.destroy++;
    summary.changes.push({ address: rc.address, actions });
  }
  return summary;
}

/**
 * Motivo per cui un plan non deve essere eseguibile, oppure undefined.
 * Cancellazioni e ricreazioni sono escluse per principio: ricreare un oggetto ne cambia l'ID
 * e rompe tutto ciò che lo referenzia (flow, script, code...).
 */
export function blockReason(summary: PlanSummary): string | undefined {
  const bad = summary.changes.filter((c) => c.actions.includes('delete'));
  if (!bad.length) return undefined;
  return (
    `Il piano cancella o ricrea ${bad.length} oggetti (${bad.map((c) => c.address).join(', ')}). ` +
    `Ricreare un oggetto ne cambia l'ID e rompe ciò che lo usa: plan non eseguibile.`
  );
}

/** Ordinamento stabile delle chiavi per confronti tra JSON */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Forma confrontabile delle modifiche di un piano: indirizzo, azioni, stato prima e dopo */
export function comparableChanges(plan: PlanJson): string {
  const changes = (plan.resource_changes ?? [])
    .map((rc) => ({
      address: rc.address,
      actions: rc.change.actions,
      before: rc.change.before ?? null,
      after: rc.change.after ?? null,
      after_unknown: rc.change.after_unknown ?? null,
    }))
    .sort((a, b) => a.address.localeCompare(b.address));
  return JSON.stringify(canonical(changes));
}

/** Differenze leggibili tra due piani (per il messaggio di deriva) */
export function describeDrift(saved: PlanJson, fresh: PlanJson): string[] {
  const index = (p: PlanJson) => new Map((p.resource_changes ?? []).map((rc) => [rc.address, rc.change]));
  const a = index(saved);
  const b = index(fresh);
  const out: string[] = [];
  for (const addr of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(addr);
    const y = b.get(addr);
    if (!x) out.push(`${addr}: nuova modifica non presente nella simulazione`);
    else if (!y) out.push(`${addr}: modifica della simulazione non più necessaria`);
    else if (JSON.stringify(canonical(x)) !== JSON.stringify(canonical(y))) {
      out.push(
        x.actions.join('+') !== y.actions.join('+')
          ? `${addr}: azione cambiata (${x.actions.join('+')} → ${y.actions.join('+')})`
          : `${addr}: l'oggetto sul target è cambiato dopo la simulazione`,
      );
    }
  }
  return out;
}

/** Risorse scritte da un apply, lette dall'output di Terraform (vale anche per un esito parziale) */
export function appliedFromOutput(output: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/^(\S+): (?:Creation|Modifications|Destruction) complete/gm)) out.add(m[1]);
  return [...out];
}
