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
  // Outbound
  'campaign',
  'messagingcampaign',
  'sequence',
  'contactlist',
  'contactlistfilter',
  'dnclist',
  'callanalysisresponseset',
  'ruleset',
  'digitalruleset',
  'campaignrule',
  'attemptlimit',
  'callabletimeset',
  'filespectemplate',
  // Messaging
  'webconfig',
  'webdeployment',
  'supportedcontent',
  // Canned response
  'responselibrary',
  'response',
  'responseasset',
  // Outbound, oggetto unico per org
  'wrapupmapping',
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
  'campaign',
  'messagingcampaign',
  'contactlist',
  'contactlistfilter',
  'dnclist',
  'callanalysisresponseset',
  'ruleset',
  'campaignrule',
  'callabletimeset',
  'responseasset',
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
  /** Oggetto contenuto nel padre (es. Canned Response di una Library): nell'ordine di creazione viene dopo il padre */
  contained?: boolean;
  repeated?: boolean;
  /** Divisione sul sorgente (solo per i tipi che prevedono le divisioni) */
  division?: DivisionRef;
  /** Problema di lettura (es. permessi mancanti): il nodo è mostrato ma le sue dipendenze o lo stato sul target sono incompleti */
  error?: string;
  /**
   * Solo Campaign e Queue: impostazioni legate alla singola org (Site, Edge Group, indirizzi email,
   * numero in uscita) da sostituire con quelle scelte sul target
   */
  settings?: SourceSettings;
}

export interface NamedRef {
  id: string;
  name: string;
}

/** Indirizzo email di una Queue: dominio + Email Route */
export interface EmailAddress {
  domainId: string;
  routeId: string;
  address: string;
}

/** Impostazioni del sorgente che non si portano: si sceglie il valore del target */
export interface SourceSettings {
  site?: NamedRef;
  edgeGroup?: NamedRef;
  emailDefault?: EmailAddress;
  emailAll?: EmailAddress[];
  /** Numero in uscita (Queue: Calling Party Number; Campaign: Caller Address) */
  phone?: { source?: string; target?: string; required: boolean };
  /** Valori attuali dell'oggetto sul target, se esiste già: proposti come scelta */
  targetCurrent?: {
    site?: NamedRef;
    edgeGroup?: NamedRef;
    emailDefault?: EmailAddress;
    emailAll?: EmailAddress[];
  };
}

/** Valori del target scelti dall'utente */
export interface TargetSettings {
  siteId?: string;
  edgeGroupId?: string;
  emailDefault?: { domainId: string; routeId: string };
  emailAll?: { domainId: string; routeId: string }[];
  phone?: string;
}

export type PortAction = 'port' | 'reuse' | 'skip';

/** Elemento scelto dall'utente per il job di porting */
export interface PortItem extends GcObjectRef {
  action: PortAction;
  targetStatus: TargetStatus;
  targetId?: string;
  /** Solo Campaign e Queue portate: valori del target scelti dall'utente */
  targetSettings?: TargetSettings;
}
