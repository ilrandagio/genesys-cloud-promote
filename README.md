# Genesys Cloud Promote

Applicazione web per promuovere oggetti Genesys Cloud da un ambiente all'altro (dev → test → prod),
con analisi delle dipendenze e confronto con il target prima di scrivere.

## Funzioni

1. **Login** all'applicazione.
2. **Ambienti**: ogni org Genesys Cloud è registrata con la propria regione e il proprio OAuth client
   (Client Credentials). Il secret è salvato cifrato (AES-256-GCM) e non viene mai restituito dalle API.
   Un ambiente può essere marcato "solo sorgente" (es. produzione in sola lettura).
3. **Porting**:
   - scelta di sorgente e target;
   - elenco degli oggetti del sorgente per tipo (flow, code, skill, wrap-up code, language, data action,
     integrazioni, schedule, schedule group, prompt) e selezione multipla anche tra tipi diversi;
   - **analisi**: albero delle dipendenze di ogni oggetto, con lo stato sul target per ciascun nodo:
     *Mancante*, *Presente uguale*, *Presente diverso* (con l'elenco dei campi diversi), *Presente*
     (esiste, contenuto non confrontato: i flow);
   - per ogni oggetto si sceglie **Porta** (crea o sovrascrive), **Usa quella del target** oppure **Salta**;
   - **Simula (plan)** mostra il `terraform plan` sul target senza scrivere nulla;
   - **Esegui porting** applica le modifiche.
4. **Storico**: tutti i job con utente, ambienti, oggetti, azioni, log e output del plan (audit).

## Architettura

```
apps/web   React + Vite + Ant Design + TanStack Query
apps/api   Fastify + TypeScript + Drizzle ORM (PostgreSQL)
           ├─ server  API REST: auth, ambienti, elenco oggetti, analisi dipendenze, job
           └─ worker  BullMQ (Redis): esegue i job di porting con Terraform (CX as Code)
```

- **Discovery e confronto** usano direttamente la Platform API (veloce, nessuno stato):
  - flow → Architect *Dependency Tracking API* (`/api/v2/architect/dependencytracking/object`);
  - code → in-queue flow, whisper prompt, skill del bullseye, wrap-up code;
  - data action → integrazione; schedule group → schedule.
  - Il match sul target è **per nome** (per i flow anche per tipo). Il confronto ignora ID, date,
    versioni e GUID, così i riferimenti contano per contenuto e non per ID.
- **Porting** delegato a CX as Code (provider `mypurecloud/genesyscloud`):
  1. `genesyscloud_tf_export` sul sorgente, solo per gli oggetti con azione *Porta*
     (`enable_dependency_resolution = false`: le dipendenze le decide l'utente);
  2. gli ID delle dipendenze *Usa quella del target* vengono rimappati sorgente → target nella configurazione esportata;
  3. gli oggetti già presenti sul target vengono importati nello state (`terraform import`): sono aggiornati, non duplicati;
  4. `plan` oppure `apply` in due fasi (prima gli oggetti non-flow, poi i flow, con un secondo tentativo
     per le dipendenze tra flow).
  La cartella di lavoro (che può contenere secret) viene cancellata a fine job.

## Permessi degli OAuth client

Creare in ogni org un OAuth client *Client Credentials* con un ruolo dedicato:

- **Sorgente**: lettura su Architect (flow, dependency tracking, prompt, schedule), Routing (code, skill,
  wrap-up code, language), Integrations (integrazioni e action), più quanto richiesto da `tf_export`.
- **Target**: gli stessi permessi in lettura più la scrittura sugli stessi oggetti (add/edit/publish dei flow).

Il pulsante *Prova connessione* nella pagina Ambienti verifica le credenziali.

## Avvio con Docker

```bash
cp .env.example .env      # compilare JWT_SECRET, ENCRYPTION_KEY, APP_USERS
docker compose up --build
```

UI su http://localhost:8080. Le migrazioni del DB partono da sole all'avvio dell'API.

## Sviluppo locale

Servono Node 22, PostgreSQL, Redis e `terraform` nel PATH (per il worker).

```bash
npm install
set -a; . ./.env; set +a
npm run dev:api      # http://localhost:3000
npm run dev:worker
npm run dev:web      # http://localhost:5173 (proxy /api verso l'API)
```

Modifiche allo schema DB: editare `apps/api/src/lib/schema.ts`, poi `npm run db:generate -w apps/api`.

## Limiti noti e prossimi passi

- **Login**: oggi utenti locali (`APP_USERS`). Per la produzione sostituire con OIDC (Entra ID / Okta / login Genesys)
  in `apps/api/src/routes/auth.ts`, mantenendo lo stesso cookie JWT.
- **Tipi di oggetto**: per aggiungerne uno basta una voce in `genesys/catalog.ts` (endpoint e tipo Terraform)
  e, se ha dipendenze, un caso in `genesys/dependencies.ts`.
- **Dipendenze non gestite** (utenti, gruppi, divisioni, data table, bot…) sono mostrate in analisi ma non portate:
  vanno verificate a mano sul target.
- **Match per nome**: oggetti con lo stesso nome in divisioni diverse non sono distinti.
- **Flow**: si porta l'ultima versione pubblicata; la Dependency Tracking API richiede che il flow sia pubblicato.
- Va validato su org reali il formato dell'export (nomi delle label, riferimenti tra risorse) con la versione
  del provider in uso: la selezione delle risorse è in `worker/exportConfig.ts`.
- Nessun ruolo applicativo: chiunque abbia accesso all'app può portare su qualunque target abilitato.
  Se serve, aggiungere un controllo (es. solo alcuni utenti verso PROD) in `routes/jobs.ts`.
