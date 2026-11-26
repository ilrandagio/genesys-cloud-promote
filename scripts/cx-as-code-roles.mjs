// Crea (o aggiorna) in un'org Genesys Cloud i due Roles per CX as Code:
//   - cx-as-code-readonly: sola lettura della configurazione. Da assegnare all'OAuth client dell'applicazione
//     (analisi, simulazione, backup, export).
//   - cx-as-code-full:     lettura e scrittura della configurazione. Da assegnare alle persone che eseguono i
//     rilasci con il proprio login.
//
// I permessi non sono scritti a mano: si leggono dall'org (GET /api/v2/authorization/permissions), che espone
// solo quelli delle licenze attive. Così il ruolo si crea sempre senza permessi "non validi" e, rilanciando lo
// script dopo un cambio di licenze, si aggiorna.
//
// Uso (Node 18+, nessuna dipendenza):
//   node scripts/cx-as-code-roles.mjs --region mypurecloud.de --client-id <id> --client-secret <secret> [--dry-run] [--out ruoli.json]
//
// L'OAuth client usato per lanciare lo script (Client Credentials) deve poter leggere i permessi e creare/modificare
// Roles: authorization:role:view/add/edit. Dopo la creazione i Roles vanno assegnati con le divisioni
// (consigliato: tutte le divisioni), all'OAuth client dell'app e agli utenti.

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const region = flag('region');
const clientId = flag('client-id');
const clientSecret = flag('client-secret');
const dryRun = argv.includes('--dry-run');
const out = flag('out');
if (!region || !clientId || !clientSecret) {
  console.error('Uso: node scripts/cx-as-code-roles.mjs --region <es. mypurecloud.de> --client-id <id> --client-secret <secret> [--dry-run] [--out file.json]');
  process.exit(1);
}

/**
 * Domains della configurazione gestita da CX as Code (le risorse del provider Terraform e le API lette dall'app).
 * Quelli non presenti nell'org (licenze) vengono ignorati.
 */
const DOMAINS = [
  'alerting', 'architect', 'authorization', 'coaching', 'directory', 'emails', 'employeeperformance', 'externalContacts',
  'gamification', 'groups', 'integrations', 'journey', 'knowledge', 'language', 'languageUnderstanding', 'learning',
  'messaging', 'notifications', 'oauth', 'organization', 'outbound', 'processautomation', 'quality', 'recording',
  'responses', 'routing', 'scripter', 'speechAndTextAnalytics', 'telephony', 'webdeployments', 'webchat',
  'workforcemanagement', 'conversation', 'flows', 'infrastructure', 'textbots', 'chat', 'dataTables', 'scim',
];

/**
 * Dati operativi, non configurazione: esclusi da entrambi i Roles (registrazioni, valutazioni, conversazioni,
 * interazioni in corso). CX as Code non li gestisce e un Role di rilascio non deve poterli leggere o cancellare.
 */
const EXCLUDED = [
  /^recording:(recording|screenRecording|recordingSegment|annotation|crossPlatformRecording|deletionPolicy)/i,
  /^quality:(evaluation|calibration|survey|agentEvaluation)$/i,
  /^conversation:(?!(settings|participant\b))/i, // di conversation serve solo la configurazione
  /^externalContacts:(contact|identifier|session|note)$/i,
  /^workforcemanagement:(agentSchedule|agentTimeOffRequest|historicalAdherence|adherence|timeOffRequest|shiftTrade|agentTimeOff)/i,
  /^coaching:appointment/i,
  /^learning:assignment/i,
];

/** Azioni di sola lettura */
const READ_ACTION = /^(view|read|search|list)/i;

const api = `https://api.${region}`;

async function token() {
  const res = await fetch(`https://login.${region}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Login fallito (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

const auth = await token();
async function call(method, path, body) {
  const res = await fetch(api + path, {
    method,
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? undefined : res.json();
}
async function listAll(path) {
  const all = [];
  for (let page = 1; ; page++) {
    const body = await call('GET', `${path}${path.includes('?') ? '&' : '?'}pageSize=100&pageNumber=${page}`);
    all.push(...(body.entities ?? []));
    if (!body.pageCount || page >= body.pageCount) return all;
  }
}

// Catalogo dei permessi dell'org: domain -> entity -> azioni
const catalog = new Map();
for (const d of await listAll('/api/v2/authorization/permissions')) {
  const entities = catalog.get(d.domain) ?? new Map();
  for (const [entity, actions] of Object.entries(d.permissionMap ?? {})) {
    const set = entities.get(entity) ?? new Set();
    for (const a of actions ?? []) set.add(a.action);
    entities.set(entity, set);
  }
  catalog.set(d.domain, entities);
}

const wanted = new Set(DOMAINS.map((d) => d.toLowerCase()));
function policies(onlyRead) {
  const out = [];
  for (const [domain, entities] of [...catalog].sort(([a], [b]) => a.localeCompare(b))) {
    if (!wanted.has(domain.toLowerCase())) continue;
    for (const [entity, actions] of [...entities].sort(([a], [b]) => a.localeCompare(b))) {
      if (EXCLUDED.some((re) => re.test(`${domain}:${entity}`))) continue;
      const actionSet = [...actions].filter((a) => !onlyRead || READ_ACTION.test(a)).sort();
      if (actionSet.length) out.push({ domain, entityName: entity, actionSet });
    }
  }
  return out;
}

const roles = [
  {
    name: 'cx-as-code-readonly',
    description: "CX as Code: sola lettura della configurazione (OAuth client dell'applicazione di porting).",
    permissionPolicies: policies(true),
  },
  {
    name: 'cx-as-code-full',
    description: 'CX as Code: lettura e scrittura della configurazione (utenti che eseguono i rilasci).',
    permissionPolicies: policies(false),
  },
];

const count = (r) => r.permissionPolicies.reduce((n, p) => n + p.actionSet.length, 0);
const skipped = DOMAINS.filter((d) => ![...catalog.keys()].some((k) => k.toLowerCase() === d.toLowerCase()));
console.log(`Domains non presenti in questa org (ignorati): ${skipped.join(', ') || 'nessuno'}`);
for (const r of roles) console.log(`${r.name}: ${r.permissionPolicies.length} entity, ${count(r)} permessi`);

if (out) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(out, JSON.stringify(roles, null, 2));
  console.log(`Definizione scritta in ${out}`);
}
if (dryRun) {
  console.log('--dry-run: nessun Role creato o modificato.');
  process.exit(0);
}

const existing = await listAll('/api/v2/authorization/roles');
for (const role of roles) {
  const found = existing.find((r) => r.name?.toLowerCase() === role.name.toLowerCase());
  if (found) {
    await call('PUT', `/api/v2/authorization/roles/${found.id}`, { ...role, id: found.id });
    console.log(`Aggiornato ${role.name} (${found.id})`);
  } else {
    const created = await call('POST', '/api/v2/authorization/roles', role);
    console.log(`Creato ${role.name} (${created.id})`);
  }
}
console.log(
  "\nPassi successivi:\n" +
    "- cx-as-code-readonly: assegnarlo all'OAuth client Client Credentials dell'app (Admin > OAuth > Roles), con tutte le divisioni;\n" +
    '- cx-as-code-full: assegnarlo alle persone che eseguono i rilasci, con tutte le divisioni.',
);
