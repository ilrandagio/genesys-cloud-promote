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
] as const;

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

export interface TargetInfo {
  status: TargetStatus;
  id?: string;
  /** Campi che differiscono (solo per status = different) */
  diff?: string[];
}

export interface DependencyNode extends GcObjectRef {
  /** false se il tipo non è gestito dal porting (es. USER, GROUP): viene mostrato ma non portato */
  supported: boolean;
  rawType?: string;
  target?: TargetInfo;
  children: DependencyNode[];
  /** true se il nodo compare già più in alto nell'albero (evita cicli) */
  repeated?: boolean;
}

export type PortAction = 'port' | 'reuse' | 'skip';

/** Elemento scelto dall'utente per il job di porting */
export interface PortItem extends GcObjectRef {
  action: PortAction;
  targetStatus: TargetStatus;
  targetId?: string;
}
