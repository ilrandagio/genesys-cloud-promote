import type { ObjectType } from './types.js';

/** Quanto serve al catalogo del client Genesys (evita dipendenze circolari) */
export interface ListingClient {
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body: unknown): Promise<T>;
  listAll<T = any>(path: string, extraQuery?: string): Promise<T[]>;
}

export type TypeGroup =
  | 'Architect'
  | 'Routing'
  | 'Integrations'
  | 'Outbound'
  | 'Messaging'
  | 'Canned Responses'
  | 'People & Permissions';

/** ID con cui il provider gestisce (e importa) i wrap-up code mappings */
export const WRAPUP_MAPPINGS_ID = 'wrapupcodemappings';

export interface TypeDef {
  label: string;
  group: TypeGroup;
  /** Oggetto unico per org: non si esporta, la configurazione la costruisce il worker */
  singleton?: boolean;
  /** Elenco personalizzato, per gli endpoint che non sono una lista paginata standard */
  list?: (client: ListingClient) => Promise<any[]>;
  /** Endpoint di lista (paginato) */
  listPath: string;
  /** Endpoint di dettaglio, {id} viene sostituito */
  getPath: string;
  /** Tipo di risorsa del provider Terraform genesyscloud */
  tfType: string;
  /** Se false il contenuto non viene confrontato (solo esistenza) */
  comparable: boolean;
}

export const CATALOG: Record<ObjectType, TypeDef> = {
  flow: {
    group: 'Architect',
    label: 'Flow',
    listPath: '/api/v2/flows',
    getPath: '/api/v2/flows/{id}',
    tfType: 'genesyscloud_flow',
    comparable: false,
  },
  queue: {
    group: 'Routing',
    label: 'Queue',
    listPath: '/api/v2/routing/queues',
    getPath: '/api/v2/routing/queues/{id}',
    tfType: 'genesyscloud_routing_queue',
    comparable: true,
  },
  skill: {
    group: 'Routing',
    label: 'ACD Skill',
    listPath: '/api/v2/routing/skills',
    getPath: '/api/v2/routing/skills/{id}',
    tfType: 'genesyscloud_routing_skill',
    comparable: true,
  },
  wrapupcode: {
    group: 'Routing',
    label: 'Wrap-up Code',
    listPath: '/api/v2/routing/wrapupcodes',
    getPath: '/api/v2/routing/wrapupcodes/{id}',
    tfType: 'genesyscloud_routing_wrapupcode',
    comparable: true,
  },
  language: {
    group: 'Routing',
    label: 'Language',
    listPath: '/api/v2/routing/languages',
    getPath: '/api/v2/routing/languages/{id}',
    tfType: 'genesyscloud_routing_language',
    comparable: true,
  },
  skillgroup: {
    group: 'Routing',
    label: 'Skill Expression Group',
    listPath: '/api/v2/routing/skillgroups',
    getPath: '/api/v2/routing/skillgroups/{id}',
    tfType: 'genesyscloud_routing_skill_group',
    comparable: true,
  },
  dataaction: {
    group: 'Integrations',
    label: 'Data Action',
    listPath: '/api/v2/integrations/actions',
    getPath: '/api/v2/integrations/actions/{id}?expand=contract&includeConfig=true',
    tfType: 'genesyscloud_integration_action',
    comparable: true,
  },
  integration: {
    group: 'Integrations',
    label: 'Integration',
    listPath: '/api/v2/integrations',
    getPath: '/api/v2/integrations/{id}',
    tfType: 'genesyscloud_integration',
    comparable: true,
  },
  schedule: {
    group: 'Architect',
    label: 'Schedule',
    listPath: '/api/v2/architect/schedules',
    getPath: '/api/v2/architect/schedules/{id}',
    tfType: 'genesyscloud_architect_schedules',
    comparable: true,
  },
  schedulegroup: {
    group: 'Architect',
    label: 'Schedule Group',
    listPath: '/api/v2/architect/schedulegroups',
    getPath: '/api/v2/architect/schedulegroups/{id}',
    tfType: 'genesyscloud_architect_schedulegroups',
    comparable: true,
  },
  script: {
    group: 'Architect',
    label: 'Script',
    listPath: '/api/v2/scripts',
    getPath: '/api/v2/scripts/{id}',
    tfType: 'genesyscloud_script',
    // Il contenuto (pagine, componenti) non è nella risposta di dettaglio: si confronta solo l'esistenza
    comparable: false,
  },
  datatable: {
    group: 'Architect',
    label: 'Data Table',
    listPath: '/api/v2/flows/datatables',
    getPath: '/api/v2/flows/datatables/{id}?expand=schema',
    tfType: 'genesyscloud_architect_datatable',
    comparable: true,
  },
  emergencygroup: {
    group: 'Architect',
    label: 'Emergency Group',
    listPath: '/api/v2/architect/emergencygroups',
    getPath: '/api/v2/architect/emergencygroups/{id}',
    tfType: 'genesyscloud_architect_emergencygroup',
    comparable: true,
  },
  division: {
    group: 'People & Permissions',
    label: 'Division',
    listPath: '/api/v2/authorization/divisions',
    getPath: '/api/v2/authorization/divisions/{id}',
    tfType: 'genesyscloud_auth_division',
    comparable: true,
  },
  group: {
    group: 'People & Permissions',
    label: 'Group',
    listPath: '/api/v2/groups',
    getPath: '/api/v2/groups/{id}',
    tfType: 'genesyscloud_group',
    comparable: true,
  },
  team: {
    group: 'People & Permissions',
    label: 'Work Team',
    listPath: '/api/v2/teams',
    getPath: '/api/v2/teams/{id}',
    tfType: 'genesyscloud_team',
    comparable: true,
  },
  role: {
    group: 'People & Permissions',
    label: 'Role',
    listPath: '/api/v2/authorization/roles',
    getPath: '/api/v2/authorization/roles/{id}',
    tfType: 'genesyscloud_auth_role',
    comparable: true,
  },
  prompt: {
    group: 'Architect',
    label: 'User Prompt',
    listPath: '/api/v2/architect/prompts',
    getPath: '/api/v2/architect/prompts/{id}',
    tfType: 'genesyscloud_architect_user_prompt',
    comparable: true,
  },

  // ---- Outbound ----
  campaign: {
    group: 'Outbound',
    label: 'Campaign',
    listPath: '/api/v2/outbound/campaigns',
    getPath: '/api/v2/outbound/campaigns/{id}',
    tfType: 'genesyscloud_outbound_campaign',
    comparable: true,
  },
  messagingcampaign: {
    group: 'Outbound',
    label: 'Messaging Campaign',
    listPath: '/api/v2/outbound/messagingcampaigns',
    getPath: '/api/v2/outbound/messagingcampaigns/{id}',
    tfType: 'genesyscloud_outbound_messagingcampaign',
    comparable: true,
  },
  sequence: {
    group: 'Outbound',
    label: 'Campaign Sequence',
    listPath: '/api/v2/outbound/sequences',
    getPath: '/api/v2/outbound/sequences/{id}',
    tfType: 'genesyscloud_outbound_sequence',
    comparable: true,
  },
  contactlist: {
    group: 'Outbound',
    label: 'Contact List',
    listPath: '/api/v2/outbound/contactlists',
    getPath: '/api/v2/outbound/contactlists/{id}',
    tfType: 'genesyscloud_outbound_contact_list',
    comparable: true,
  },
  contactlistfilter: {
    group: 'Outbound',
    label: 'Contact List Filter',
    listPath: '/api/v2/outbound/contactlistfilters',
    getPath: '/api/v2/outbound/contactlistfilters/{id}',
    tfType: 'genesyscloud_outbound_contactlistfilter',
    comparable: true,
  },
  dnclist: {
    group: 'Outbound',
    label: 'DNC List',
    listPath: '/api/v2/outbound/dnclists',
    getPath: '/api/v2/outbound/dnclists/{id}',
    tfType: 'genesyscloud_outbound_dnclist',
    comparable: true,
  },
  callanalysisresponseset: {
    group: 'Outbound',
    label: 'Call Analysis Response Set',
    listPath: '/api/v2/outbound/callanalysisresponsesets',
    getPath: '/api/v2/outbound/callanalysisresponsesets/{id}',
    tfType: 'genesyscloud_outbound_callanalysisresponseset',
    comparable: true,
  },
  ruleset: {
    group: 'Outbound',
    label: 'Rule Set',
    listPath: '/api/v2/outbound/rulesets',
    getPath: '/api/v2/outbound/rulesets/{id}',
    tfType: 'genesyscloud_outbound_ruleset',
    comparable: true,
  },
  digitalruleset: {
    group: 'Outbound',
    label: 'Digital Rule Set',
    listPath: '/api/v2/outbound/digitalrulesets',
    getPath: '/api/v2/outbound/digitalrulesets/{id}',
    tfType: 'genesyscloud_outbound_digitalruleset',
    comparable: true,
  },
  campaignrule: {
    group: 'Outbound',
    label: 'Campaign Rule',
    listPath: '/api/v2/outbound/campaignrules',
    getPath: '/api/v2/outbound/campaignrules/{id}',
    tfType: 'genesyscloud_outbound_campaignrule',
    comparable: true,
  },
  attemptlimit: {
    group: 'Outbound',
    label: 'Attempt Limit',
    listPath: '/api/v2/outbound/attemptlimits',
    getPath: '/api/v2/outbound/attemptlimits/{id}',
    tfType: 'genesyscloud_outbound_attempt_limit',
    comparable: true,
  },
  callabletimeset: {
    group: 'Outbound',
    label: 'Callable Time Set',
    listPath: '/api/v2/outbound/callabletimesets',
    getPath: '/api/v2/outbound/callabletimesets/{id}',
    tfType: 'genesyscloud_outbound_callabletimeset',
    comparable: true,
  },
  filespectemplate: {
    group: 'Outbound',
    label: 'File Specification Template',
    listPath: '/api/v2/outbound/filespecificationtemplates',
    getPath: '/api/v2/outbound/filespecificationtemplates/{id}',
    tfType: 'genesyscloud_outbound_filespecificationtemplate',
    comparable: true,
  },
  wrapupmapping: {
    group: 'Outbound',
    label: 'Wrap-up Code Mappings',
    listPath: '/api/v2/outbound/wrapupcodemappings',
    getPath: '/api/v2/outbound/wrapupcodemappings',
    tfType: 'genesyscloud_outbound_wrapupcodemappings',
    // Oggetto unico per org (singleton): un solo elemento con nome e ID fissi, uguali su ogni org
    list: async (c) => {
      try {
        await c.get('/api/v2/outbound/wrapupcodemappings');
        return [{ id: WRAPUP_MAPPINGS_ID, name: 'Wrap-up code mappings' }];
      } catch {
        return [];
      }
    },
    // Il porting unisce sorgente e target: il confronto riga per riga lo fa il plan
    comparable: false,
    singleton: true,
  },

  // ---- Messaging ----
  webconfig: {
    group: 'Messaging',
    label: 'Messenger Configuration',
    listPath: '/api/v2/webdeployments/configurations',
    getPath: '/api/v2/webdeployments/configurations/{id}/versions/draft',
    tfType: 'genesyscloud_webdeployments_configuration',
    // Elenco non paginato: una sola chiamata
    list: async (c) => (await c.get<{ entities?: any[] }>('/api/v2/webdeployments/configurations')).entities ?? [],
    // Versioni e bozze differiscono sempre tra org: si confronta solo l'esistenza
    comparable: false,
  },
  webdeployment: {
    group: 'Messaging',
    label: 'Messenger Deployment',
    listPath: '/api/v2/webdeployments/deployments',
    getPath: '/api/v2/webdeployments/deployments/{id}',
    tfType: 'genesyscloud_webdeployments_deployment',
    list: async (c) => (await c.get<{ entities?: any[] }>('/api/v2/webdeployments/deployments')).entities ?? [],
    comparable: true,
  },
  supportedcontent: {
    group: 'Messaging',
    label: 'Supported Content',
    listPath: '/api/v2/conversations/messaging/supportedcontent',
    getPath: '/api/v2/conversations/messaging/supportedcontent/{id}',
    tfType: 'genesyscloud_conversations_messaging_supportedcontent',
    comparable: true,
  },

  // ---- Canned response ----
  responselibrary: {
    group: 'Canned Responses',
    label: 'Canned Response Library',
    listPath: '/api/v2/responsemanagement/libraries',
    getPath: '/api/v2/responsemanagement/libraries/{id}',
    tfType: 'genesyscloud_responsemanagement_library',
    comparable: true,
  },
  response: {
    group: 'Canned Responses',
    label: 'Canned Response',
    listPath: '/api/v2/responsemanagement/responses',
    getPath: '/api/v2/responsemanagement/responses/{id}',
    tfType: 'genesyscloud_responsemanagement_response',
    // Le risposte si elencano per libreria (libraryId obbligatorio); una risposta può stare in più librerie
    list: async (c) => {
      const out = new Map<string, any>();
      for (const lib of await c.listAll('/api/v2/responsemanagement/libraries')) {
        for (const r of await c.listAll(`/api/v2/responsemanagement/responses?libraryId=${lib.id}`)) out.set(r.id, r);
      }
      return [...out.values()];
    },
    comparable: true,
  },
  responseasset: {
    group: 'Canned Responses',
    label: 'Canned Response Asset',
    listPath: '/api/v2/responsemanagement/responseassets/search',
    getPath: '/api/v2/responsemanagement/responseassets/{id}',
    tfType: 'genesyscloud_responsemanagement_responseasset',
    // Nessuna lista GET: ricerca paginata, come fa il provider Terraform
    list: async (c) => {
      const out: any[] = [];
      for (let page = 1; ; page++) {
        const res = await c.post<{ results?: any[]; pageCount?: number }>('/api/v2/responsemanagement/responseassets/search', {
          pageSize: 100,
          pageNumber: page,
        });
        out.push(...(res.results ?? []));
        if (!res.pageCount || page >= res.pageCount || !res.results?.length) break;
      }
      return out;
    },
    // File binario: si confronta solo l'esistenza (per nome)
    comparable: false,
  },
};

/** Elenco di tutti gli oggetti di un tipo su un'org */
export function listObjects(client: ListingClient, type: ObjectType): Promise<any[]> {
  const def = CATALOG[type];
  return def.list ? def.list(client) : client.listAll(def.listPath);
}

/** Tipo restituito dalla Dependency Tracking API -> nostro ObjectType */
export function fromDependencyType(dtType: string): ObjectType | undefined {
  switch (dtType) {
    case 'QUEUE':
      return 'queue';
    case 'ACDSKILL':
      return 'skill';
    case 'ACDWRAPUPCODE':
      return 'wrapupcode';
    case 'ACDLANGUAGE':
    case 'LANGUAGE':
      return 'language';
    case 'DATAACTION':
      return 'dataaction';
    case 'SCHEDULE':
      return 'schedule';
    case 'SCHEDULEGROUP':
      return 'schedulegroup';
    case 'USERPROMPT':
      return 'prompt';
    case 'SCRIPT':
    case 'COMPOSERSCRIPT':
      return 'script';
    case 'DATATABLE':
      return 'datatable';
    case 'EMERGENCYGROUP':
      return 'emergencygroup';
    default:
      return dtType.endsWith('FLOW') || dtType === 'WORKFLOW' ? 'flow' : undefined;
  }
}

/** Tipo di flow (campo "type" di /api/v2/flows) -> objectType della Dependency Tracking API */
export function flowDependencyType(flowType: string): string {
  const t = flowType.toUpperCase();
  return t === 'WORKFLOW' ? 'WORKFLOW' : `${t}FLOW`;
}
