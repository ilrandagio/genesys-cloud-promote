# Genesys Cloud Promote

Applicazione web per promuovere oggetti Genesys Cloud da un ambiente all'altro (dev → test → prod),
con analisi delle dipendenze e confronto con il target prima di scrivere.

## Funzioni

1. **Login con Genesys Cloud**: ogni utente entra con il proprio account dell'org di login
   (OAuth Authorization Code + PKCE), con accesso eventualmente limitato a un ruolo Genesys o a un elenco di email.
2. **Ambienti**: ogni org Genesys Cloud è registrata con la propria regione e il proprio OAuth client
   (Client Credentials). Il secret è salvato cifrato (AES-256-GCM) e non viene mai restituito dalle API.
   Un ambiente può essere marcato "solo sorgente" (es. produzione in sola lettura) o "protetto"
   (i plan verso di esso richiedono l'approvazione di una seconda persona).
3. **Porting**:
   - scelta di sorgente e target;
   - elenco degli oggetti del sorgente per tipo, raggruppati (vedi *Tipi supportati*), e selezione multipla anche tra tipi diversi;
   - **analisi**: albero delle dipendenze di ogni oggetto, con lo stato sul target per ciascun nodo:
     *Mancante*, *Presente uguale*, *Presente diverso* (con l'elenco dei campi diversi), *Presente*
     (esiste, contenuto non confrontato: i flow);
   - per ogni oggetto si sceglie **Porta** (crea o sovrascrive) oppure, in alternativa, **Usa quella del target** se
     l'oggetto esiste già sul target, **Salta** se manca (i riferimenti a quell'oggetto restano scoperti);
     accanto a *Simula* un filtro mostra l'elenco dei soli oggetti con una certa azione;
   - **Simula (plan)** calcola e salva il piano delle modifiche sul target senza scrivere nulla;
     la selezione resta disponibile e il plan si apre in un pannello laterale;
   - **Approva** (sui target protetti, da una persona diversa da chi ha creato il plan);
   - **Esegui il plan** applica esattamente il piano salvato, una sola volta, dopo aver verificato che il target
     non sia cambiato.
4. **Storico**: simulazioni ed esecuzioni con stato del plan, modifiche, chi ha simulato, approvato ed eseguito,
   risorse scritte, log e output (audit).

## Tipi supportati

| Gruppo | Tipi |
|---|---|
| Architect | Flows, Schedules, Schedule Groups, User Prompts, Scripts, Data Tables, Emergency Groups |
| Routing | Queues, ACD Skills, Wrap-up Codes, Languages, Skill Expression Groups |
| Integrations | Integrations, Data Actions |
| Outbound | Campaigns, Messaging Campaigns, Campaign Sequences, Contact Lists, Contact List Filters, DNC Lists, Call Analysis Response Sets, Rule Sets, Digital Rule Sets, Campaign Rules, Attempt Limits, Callable Time Sets, File Specification Templates, Wrap-up Code Mappings |
| Messaging | Messenger Configurations, Messenger Deployments, Supported Content |
| Canned Responses | Libraries, Responses, Assets |
| People & Permissions | Divisions, Groups (con i Roles assegnati), Roles |

### Regole di sicurezza applicate automaticamente

- **Campaigns e Campaign Sequences arrivano spente** sul target (`campaign_status`/`status` = `off`): si avviano a mano dopo il rilascio.
- **Impostazioni legate all'org si scelgono sul target** (Campaigns e Queues). Nell'analisi, sulla riga dell'oggetto
  da portare, si sceglie:
  - **Site ed Edge Group** (Campaign; callback della Queue), proposti per nome uguale a quelli del sorgente;
  - **indirizzo email in uscita** della Queue (dominio + Email Route) ed eventuale elenco completo degli indirizzi,
    proposti per parte prima della `@` uguale a quella del sorgente (i domini di solito cambiano tra org);
  - **numero in uscita** (Queue: Calling Party Number; Campaign: Caller Address): quello del target se l'oggetto esiste
    già, altrimenti da inserire a mano. Obbligatorio per le Campaigns che lo avevano; per le Queues vuoto = nessun numero.

  Senza le scelte obbligatorie la simulazione non parte; il worker verifica che i valori scelti esistano sul target.
- **Membri delle Queues mai portati né toccati**: non vengono esportati (`members`, Groups, Teams, Skill Groups).
  Sul target la Queue ha `ignore_members = true`, quindi i membri presenti restano; Groups, Teams e Skill Groups sono
  quelli del target se la Queue esiste già, nessuno se è nuova. Gli indirizzi di messaggistica in uscita (SMS, WhatsApp,
  Open Messaging) sono quelli del target se la Queue esiste già, altrimenti nessuno.
- **Groups**: i membri (`member_ids`, `owner_ids`) non vengono esportati, sul target restano quelli presenti. I **Roles
  assegnati** al Group sul sorgente, con le loro Divisions, vengono assegnati anche sul target (`genesyscloud_group_roles`,
  costruito dal worker): Role riusato o portato nello stesso rilascio, Division abbinata per nome (`*` = tutte). Le
  assegnazioni del Group sul target vengono sostituite da quelle del sorgente; un Group senza Roles sul sorgente non tocca
  quelle del target. Un Role o una Division non disponibili sul target fermano la simulazione con l'elenco.
- **Gli utenti non si portano mai**: né come membri od owner di Groups e Queues, né come assegnatari dei Roles. Un Role
  con una condizione su un utente specifico ferma la simulazione (l'ID dell'utente è diverso sul target).
- **Le Contact Lists si portano senza contatti**: viene creata la struttura (colonne, numeri, Attempt Limit), i dati non escono dal sorgente.
- **Canned Response Assets**: il file viene scaricato dal sorgente e caricato sul target. I link all'asset presenti nel
  testo delle Responses vengono riscritti con l'URL dell'asset sul target: se l'asset è già sul target si usa il suo URL,
  se viene caricato nello stesso rilascio si usa il riferimento Terraform `content_location` (valorizzato dopo il caricamento,
  che quindi avviene prima della Response).
- **Wrap-up Code Mappings** (oggetto unico per org): non si sovrascrivono, si **uniscono**. Si parte dalla mappatura del
  target e si applicano i flag dei Wrap-up Codes del sorgente presenti sul target (o portati nello stesso rilascio);
  le associazioni che esistono solo sul target restano, il Default Set resta quello del target. Se un Wrap-up Code
  della mappatura del sorgente non è sul target e non viene portato, la simulazione si ferma con l'elenco.
- **Messenger Deployment**: punta alla versione della Messenger Configuration creata nello stesso rilascio oppure all'ultima versione
  pubblicata della Messenger Configuration già presente sul target.

## Architettura

Documento architetturale completo: [doc/architettura.md](doc/architettura.md), anche in Word ([doc/architettura.docx](doc/architettura.docx), rigenerabile con `python3 scripts/build-doc-docx.py`).


```
apps/web   React + Vite + Ant Design + TanStack Query
apps/api   Fastify + TypeScript + Drizzle ORM (PostgreSQL)
           ├─ server  API REST: auth, ambienti, elenco oggetti, analisi dipendenze, job
           └─ worker  BullMQ (Redis): esegue i job di porting con Terraform (CX as Code)
```

- **Discovery e confronto** usano direttamente la Platform API (veloce, nessuno stato). L'albero è completo e
  ricorsivo: ogni oggetto trovato viene analizzato a sua volta, e se compare in più rami mostra ovunque tutte le sue
  dipendenze; il ramo si ferma solo in caso di dipendenza circolare:
  - flow → unione di due fonti: Architect *Dependency Tracking API* (`/api/v2/architect/dependencytracking/object`,
    affidabile solo se Genesys ha già calcolato le dipendenze) e gli ID degli oggetti trovati nella configurazione
    del flow (`/api/v2/flows/{id}/latestconfiguration`): data action, data table, code, altri flow, prompt, script…;
  - i riferimenti si riconoscono per ID (anche con prefisso, es. `custom_-_<guid>` delle data action) e per nome.
    Nei **flow** i riferimenti sono per nome: vale il nome esatto di qualunque tipo di oggetto (anche come chiave di
    un blocco, es. il nome della data action), i prompt nella forma `Prompt.<nome>`; le espressioni Architect
    (`Flow.`, `Task.`, `State.`…) sono ignorate. Nell'albero questi nodi hanno il tag "per nome".
    Negli **script** il nome vale solo se univoco e per data action, data table, flow, emergency group e schedule group;
  - nel porting i riferimenti per nome dei flow non vengono modificati: sul target si risolvono per nome,
    basta che gli oggetti esistano con lo stesso nome;
  - nell'albero l'icona `</>` accanto a flow e script apre la configurazione grezza letta da Genesys, utile per
    capire perché un riferimento non viene riconosciuto;
  - code → in-queue flow, whisper prompt, skill del bullseye, wrap-up code;
  - data action → integrazione; schedule group → schedule;
  - script agente → tutti gli ID presenti nel JSON dello script (data action, code, flow, wrap-up code…),
    riconosciuti confrontandoli con gli oggetti dell'org sorgente. Gli ID interni dello script (pagine, componenti,
    variabili, azioni) e l'ID dello script stesso non sono dipendenze e non vengono mai sostituiti.
  - Il match sul target è **per nome** (per i flow anche per tipo). Il confronto ignora ID, date,
    versioni e GUID, così i riferimenti contano per contenuto e non per ID.
- **Porting** delegato a CX as Code (provider `mypurecloud/genesyscloud`), sempre in due tempi:
  **simulazione (plan)** e poi **esecuzione di quel plan**. Non esiste un'esecuzione diretta.

  *Simulazione*
  1. `genesyscloud_tf_export` sul sorgente, solo per gli oggetti con azione *Porta*
     (`enable_dependency_resolution = false`: le dipendenze le decide l'utente);
  2. gli ID delle dipendenze *Usa quella del target* vengono rimappati sorgente → target nella configurazione esportata;
  3. gli ID scritti in chiaro nei file esportati (JSON degli script, YAML dei flow) vengono sostituiti
     con gli ID del target; per gli oggetti creati nello stesso porting si usa un segnaposto `{{gcp_N}}`
     riempito da Terraform tramite `substitutions`;
  4. l'ordine di creazione viene dall'albero delle dipendenze (`depends_on`): prima ciò che è usato, poi chi lo usa;
     un ciclo emerge già qui, non durante l'esecuzione;
  5. gli oggetti già presenti sul target vengono importati nello state (`terraform import`): sono aggiornati, non duplicati;
  6. `terraform plan -out`: il piano viene salvato. Cartella di lavoro completa (configurazione, file, state, piano,
     lock dei provider) e identità del target vengono salvate **cifrate nel database** insieme al plan.
     Un piano con cancellazioni o ricreazioni viene **bloccato** (ricreare un oggetto ne cambia l'ID).

  *Esecuzione del plan*
  1. il plan viene "consumato" in modo atomico: si esegue **una sola volta** (un indice univoco sul database lo garantisce
     anche con richieste simultanee); deve essere completato, non bloccato, non scaduto e, sui target protetti, approvato;
  2. il worker ricontrolla tutto, ricrea la cartella del plan e verifica che il target sia ancora lo stesso ambiente;
  3. **controllo di deriva**: il piano viene ricalcolato sul target e confrontato con quello salvato; se il target è cambiato
     dopo la simulazione non viene applicato nulla e va rifatta la simulazione;
  4. `terraform apply <piano salvato>`: viene applicato esattamente ciò che è stato simulato, senza riesportare dal sorgente;
  5. l'esito riporta le risorse effettivamente scritte (anche in caso di errore a metà); l'artefatto viene cancellato.

  Le cartelle di lavoro temporanee vengono cancellate a fine job; gli artefatti dei plan scaduti o eseguiti vengono
  eliminati automaticamente.

## Autorizzazioni e approvazione (4 occhi)

| Azione | Chi può farla |
|---|---|
| Analisi e simulazione | qualunque utente autenticato |
| Esecuzione di un plan | utenti con `GENESYS_APPLY_ROLE` o in `APP_APPLY_EMAILS` (se entrambi vuoti: tutti) |
| Approvazione | utenti con `GENESYS_APPROVER_ROLE` o in `APP_APPROVER_EMAILS` (se entrambi vuoti: tutti), **mai chi ha creato il plan** |

- Un ambiente con **Richiede approvazione** (pagina Ambienti, consigliato per la produzione) accetta solo plan approvati.
- I permessi sono letti dai ruoli Genesys al login: dopo una modifica dei ruoli serve uscire e rientrare.
- Un plan vale `PLAN_TTL_HOURS` ore (predefinito 24); può essere scartato da chi l'ha creato o da un approvatore.
- Lo storico registra chi ha simulato, chi ha approvato, chi ha eseguito e quali risorse sono state scritte.
- Un job interrotto da un riavvio viene chiuso come fallito e non viene mai ripreso in automatico.

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

- **Sorgente**: lettura su Architect (Flows, Dependency Tracking, User Prompts, Schedules), Routing (Queues, ACD Skills,
  Wrap-up Codes, Languages), Integrations (Integrations e Data Actions), Outbound (Campaigns, Contact Lists, Rule Sets, ecc.),
  Web Deployments (Messenger Configurations e Deployments), Response Management (Libraries, Responses, Assets), più quanto richiesto da `tf_export`.
- **Target**: gli stessi permessi in lettura più la scrittura sugli stessi oggetti (add/edit/publish dei flow),
  e la lettura di Telephony (Sites, Edge Groups) e Routing Email (domini ed Email Routes) per le scelte sul target.

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

**Database.** Senza `DATABASE_URL` l'app usa un PostgreSQL integrato (PGlite) nella cartella `data/`: comodo per provare,
ma una chiusura brusca del processo può danneggiarlo (l'app chiude in modo ordinato con Ctrl+C, ma non se il processo
viene terminato forzatamente). **Per plan, approvazioni e storico che devono durare usare PostgreSQL**: su Windows si
installa gratuitamente senza Docker (installer ufficiale) e basta impostare
`DATABASE_URL=postgres://utente:password@localhost:5432/gcpromote` nel `.env`.

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
- **Dipendenze non gestite** (Users, Groups, Divisions, Data Tables, Bots…) sono mostrate in analisi ma non portate:
  vanno verificate a mano sul target.
- **Match per nome**: oggetti con lo stesso nome in Divisions diverse non sono distinti.
- **Data Tables**: viene portata la struttura della tabella, non le righe.
- **Flow**: si porta l'ultima versione pubblicata; la Dependency Tracking API richiede che il flow sia pubblicato.
- Va validato su org reali il formato dell'export (nomi delle label, riferimenti tra risorse) con la versione
  del provider in uso: la selezione delle risorse è in `worker/exportConfig.ts`.
- Nessun ruolo applicativo: chiunque abbia accesso all'app può portare su qualunque target abilitato.
  Se serve, aggiungere un controllo (es. solo alcuni utenti verso PROD) in `routes/jobs.ts`.
