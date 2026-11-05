export const OBJECT_TYPES = [
  'flow',
  'queue',
  'skill',
  'wrapupcode',
  'language',
  'dataaction',
  'integration',
  'schedule',
  'schedulegroup',
  'prompt',
  'division',
  'script',
  'datatable',
  'emergencygroup',
] as const;

/** Tipi che in Genesys Cloud appartengono a una divisione */
export const DIVISIONED_TYPES: ReadonlySet<ObjectType> = new Set<ObjectType>([
  'flow',
  'queue',
  'schedule',
  'schedulegroup',
  'wrapupcode',
  'script',
  'datatable',
  'emergencygroup',
]);

export type ObjectType = (typeof OBJECT_TYPES)[number];

export interface GcObjectRef {
  type: ObjectType;
  id: string;
  name: string;
  /** Per i flow: INBOUNDCALL, INQUEUECALL, BOT... */
  subtype?: string;
}

/**
 * Stato dell'oggetto sul target:
 * - missing: non esiste (match per nome)
 * - same: esiste e la configurazione normalizzata coincide
 * - different: esiste ma la configurazione differisce
 * - present: esiste, contenuto non confrontabile (es. flow)
 */
export type TargetStatus = 'missing' | 'same' | 'different' | 'present';

export interface DivisionRef {
  id?: string;
  name: string;
}

/**
 * Divisione reale dell'oggetto, oppure undefined.
 * Genesys indica gli oggetti senza divisione (es. script non assegnati) con id e nome "*":
 * non è una divisione da cercare o creare sul target.
 */
export function toDivision(raw: { id?: string; name?: string } | null | undefined): DivisionRef | undefined {
  if (!raw) return undefined;
  const id = raw.id?.trim();
  const name = raw.name?.trim();
  if (!id && !name) return undefined;
  if (id === '*' || name === '*') return undefined;
  return { id, name: name || id! };
}

export interface TargetInfo {
  status: TargetStatus;
  id?: string;
  /** Divisione dell'oggetto corrispondente sul target */
  division?: DivisionRef;
  /** true se la divisione del sorgente non esiste sul target (il porting fallirebbe) */
  divisionMissing?: boolean;
  /** Campi che differiscono (solo per status = different) */
  diff?: string[];
}

export interface DependencyNode extends GcObjectRef {
  /** false se il tipo non è gestito dal porting (es. USER, GROUP): viene mostrato ma non portato */
  supported: boolean;
  rawType?: string;
  target?: TargetInfo;
  children: DependencyNode[];
  /** true se l'oggetto è già un antenato in questo ramo: dipendenza circolare, il ramo si ferma qui */
  repeated?: boolean;
  /** Divisione sul sorgente (solo per i tipi che prevedono le divisioni) */
  division?: DivisionRef;
  /** Problema di lettura (es. permessi mancanti): il nodo è mostrato ma le sue dipendenze o lo stato sul target sono incompleti */
  error?: string;
}

export type PortAction = 'port' | 'reuse' | 'skip';

/** Elemento scelto dall'utente per il job di porting */
export interface PortItem extends GcObjectRef {
  action: PortAction;
  targetStatus: TargetStatus;
  targetId?: string;
}
