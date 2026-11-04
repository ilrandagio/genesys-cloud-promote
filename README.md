# Genesys Cloud Promote

Applicazione web per promuovere oggetti Genesys Cloud da un ambiente all'altro (dev → test → prod),
con analisi delle dipendenze e confronto con il target prima di scrivere.

## Funzioni

1. **Login con Genesys Cloud**: ogni utente entra con il proprio account dell'org di login
   (OAuth Authorization Code + PKCE), con accesso eventualmente limitato a un ruolo Genesys o a un elenco di email.
2. **Ambienti**: ogni org Genesys Cloud è registrata con la propria regione e il proprio OAuth client
   (Client Credentials). Il secret è salvato cifrato (AES-256-GCM) e non viene mai restituito dalle API.
   Un ambiente può essere marcato "solo sorgente" (es. produzione in sola lettura).
3. **Porting**:
   - scelta di sorgente e target;
   - elenco degli oggetti del sorgente per tipo (flow, code, skill, wrap-up code, language, data action,
     integrazioni, schedule, schedule group, prompt, script agente, divisioni) e selezione multipla anche tra tipi diversi;
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
  - data action → integrazione; schedule group → schedule;
  - script agente → tutti gli ID presenti nel JSON dello script (data action, code, flow, wrap-up code…),
    riconosciuti confrontandoli con gli oggetti dell'org sorgente. Gli ID interni dello script (pagine, componenti,
    variabili, azioni) e l'ID dello script stesso non sono dipendenze e non vengono mai sostituiti.
  - Il match sul target è **per nome** (per i flow anche per tipo). Il confronto ignora ID, date,
    versioni e GUID, così i riferimenti contano per contenuto e non per ID.
- **Porting** delegato a CX as Code (provider `mypurecloud/genesyscloud`):
  1. `genesyscloud_tf_export` sul sorgente, solo per gli oggetti con azione *Porta*
     (`enable_dependency_resolution = false`: le dipendenze le decide l'utente);
  2. gli ID delle dipendenze *Usa quella del target* vengono rimappati sorgente → target nella configurazione esportata;
  3. gli ID scritti in chiaro nei file esportati (JSON degli script, YAML dei flow) vengono sostituiti
     con gli ID del target; per gli oggetti creati nello stesso porting si usa un segnaposto `{{gcp_N}}`
     riempito da Terraform tramite `substitutions`, così l'ordine di creazione è garantito;
  4. gli oggetti già presenti sul target vengono importati nello state (`terraform import`): sono aggiornati, non duplicati;
  5. `plan` oppure `apply` in due fasi (prima gli oggetti non-flow, poi i flow, con un secondo tentativo
     per le dipendenze tra flow).
  La cartella di lavoro (che può contenere secret) viene cancellata a fine job.

## Login con Genesys Cloud

L'accesso all'app avviene con un account Genesys Cloud di un'org scelta come "org di login"
(di solito quella del team, oppure l'org di sviluppo del cliente). Nell'org di login creare un OAuth client:

- *Admin → Integrations → OAuth → Add Client*;
- **Grant Type: Code Authorization**;
- **Authorized redirect URI**: `APP_URL/api/auth/callback`
  (in locale `http://localhost:5173/api/auth/callback`, con Docker `http://localhost:8080/api/auth/callback`);
- nessun ruolo da assegnare: il client agisce con i permessi dell'utente e legge solo il suo profilo.

Nel `.env`: `GENESYS_LOGIN_REGION`, `GENESYS_LOGIN_CLIENT_ID`, `GENESYS_LOGIN_CLIENT_SECRET`.
Per limitare l'accesso (consigliato): `GENESYS_LOGIN_REQUIRED_ROLE` (nome di un ruolo Genesys, es. creare il ruolo
"Promote Users" e assegnarlo alle persone abilitate) e/o `APP_ALLOWED_EMAILS`.

Il login Genesys identifica chi usa l'app; le operazioni sugli ambienti usano invece gli OAuth client
Client Credentials configurati nella pagina Ambienti (sezione successiva). Lo storico dei job registra l'email dell'utente.

## Permessi degli OAuth client degli ambienti

Creare in ogni org un OAuth client *Client Credentials* con un ruolo dedicato:

- **Sorgente**: lettura su Architect (flow, dependency tracking, prompt, schedule), Routing (code, skill,
  wrap-up code, language), Integrations (integrazioni e action), più quanto richiesto da `tf_export`.
- **Target**: gli stessi permessi in lettura più la scrittura sugli stessi oggetti (add/edit/publish dei flow).

Il pulsante *Prova connessione* nella pagina Ambienti verifica le credenziali.

## Avvio in locale senza Docker (Windows, macOS, Linux)

Servono solo:
- **Node.js 22** (LTS);
- **Terraform** (un unico eseguibile da mettere nel PATH; serve solo per *Simula* ed *Esegui porting*).

```bash
git clone https://github.com/ilrandagio/genesys-cloud-promote.git
cd genesys-cloud-promote
npm install
npm run setup -- --region mypurecloud.de --client-id <id> --client-secret <secret>   # crea .env
npm run dev                              # avvia API e interfaccia insieme
```

Aprire http://localhost:5173 e premere **Accedi con Genesys Cloud**. Prima serve il client OAuth di login (vedi sopra).

In questa modalità (nessun `DATABASE_URL` / `REDIS_URL` nel `.env`):
- il database è PostgreSQL integrato (PGlite), salvato nella cartella `data/`;
- i job di porting girano nello stesso processo dell'API, uno alla volta; un job in corso viene
  segnato come fallito se l'app viene riavviata.

Per cancellare tutti i dati locali basta eliminare la cartella `data/`.

## Avvio con Docker

```bash
cp .env.example .env      # compilare JWT_SECRET, ENCRYPTION_KEY e GENESYS_LOGIN_*, APP_URL=http://localhost:8080
docker compose up --build
```

UI su http://localhost:8080. Qui si usano PostgreSQL e Redis veri e il worker è un container separato.
Le migrazioni del DB partono da sole all'avvio dell'API.

## Sviluppo

- `npm run dev:api`, `npm run dev:web`, `npm run dev:worker` (il worker serve solo con `REDIS_URL`).
- Il `.env` nella radice viene letto automaticamente dall'API.
- Modifiche allo schema DB: editare `apps/api/src/lib/schema.ts`, poi `npm run db:generate -w apps/api`.

## Limiti noti e prossimi passi

- **Login**: una sola org di login per istanza. Le operazioni sugli ambienti usano i client Client Credentials,
  non i permessi dell'utente loggato.
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
