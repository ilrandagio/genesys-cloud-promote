import type { ObjectType } from './types.js';

export interface TypeDef {
  label: string;
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
    label: 'Flow Architect',
    listPath: '/api/v2/flows',
    getPath: '/api/v2/flows/{id}',
    tfType: 'genesyscloud_flow',
    comparable: false,
  },
  queue: {
    label: 'Code',
    listPath: '/api/v2/routing/queues',
    getPath: '/api/v2/routing/queues/{id}',
    tfType: 'genesyscloud_routing_queue',
    comparable: true,
  },
  skill: {
    label: 'Skill',
    listPath: '/api/v2/routing/skills',
    getPath: '/api/v2/routing/skills/{id}',
    tfType: 'genesyscloud_routing_skill',
    comparable: true,
  },
  wrapupcode: {
    label: 'Wrap-up code',
    listPath: '/api/v2/routing/wrapupcodes',
    getPath: '/api/v2/routing/wrapupcodes/{id}',
    tfType: 'genesyscloud_routing_wrapupcode',
    comparable: true,
  },
  language: {
    label: 'Language',
    listPath: '/api/v2/routing/languages',
    getPath: '/api/v2/routing/languages/{id}',
    tfType: 'genesyscloud_routing_language',
    comparable: true,
  },
  dataaction: {
    label: 'Data action',
    listPath: '/api/v2/integrations/actions',
    getPath: '/api/v2/integrations/actions/{id}?expand=contract&includeConfig=true',
    tfType: 'genesyscloud_integration_action',
    comparable: true,
  },
  integration: {
    label: 'Integrazione',
    listPath: '/api/v2/integrations',
    getPath: '/api/v2/integrations/{id}',
    tfType: 'genesyscloud_integration',
    comparable: true,
  },
  schedule: {
    label: 'Schedule',
    listPath: '/api/v2/architect/schedules',
    getPath: '/api/v2/architect/schedules/{id}',
    tfType: 'genesyscloud_architect_schedules',
    comparable: true,
  },
  schedulegroup: {
    label: 'Schedule group',
    listPath: '/api/v2/architect/schedulegroups',
    getPath: '/api/v2/architect/schedulegroups/{id}',
    tfType: 'genesyscloud_architect_schedulegroups',
    comparable: true,
  },
  division: {
    label: 'Divisione',
    listPath: '/api/v2/authorization/divisions',
    getPath: '/api/v2/authorization/divisions/{id}',
    tfType: 'genesyscloud_auth_division',
    comparable: true,
  },
  prompt: {
    label: 'User prompt',
    listPath: '/api/v2/architect/prompts',
    getPath: '/api/v2/architect/prompts/{id}',
    tfType: 'genesyscloud_architect_user_prompt',
    comparable: true,
  },
};

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
    default:
      return dtType.endsWith('FLOW') || dtType === 'WORKFLOW' ? 'flow' : undefined;
  }
}

/** Tipo di flow (campo "type" di /api/v2/flows) -> objectType della Dependency Tracking API */
export function flowDependencyType(flowType: string): string {
  const t = flowType.toUpperCase();
  return t === 'WORKFLOW' ? 'WORKFLOW' : `${t}FLOW`;
}
