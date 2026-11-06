# WaveTech HRMS

One internal HR system that carries a person from job applicant to employee on a single record, then drives their payroll and leave from it. Built for Pakistani payroll rules (CNIC, EOBI, Provident Fund, withholding tax). The full design is in [WaveTech HRMS — System Design.md](WaveTech%20HRMS%20—%20System%20Design.md).

Modules:

- **Recruitment** – candidates, a drag-and-drop pipeline board, interviews, a contact log with follow-ups, and a hire action that creates the employee
- **Employees** – the staff register, documents, and activation checks (CNIC and signed contract required)
- **Payroll** – salary structures with history, monthly runs computed as A + B − C with mid-month proration, loans and advances, CSV and bank files, and printable payslips
- **Leave** – leave types, a balance ledger, approvals (HR or line manager), and unpaid days that flow into payroll
- **Sales** – sales credited to closers and fronters (the CRM's compliance-approved sales, or recorded by hand), slab-based incentives that flow into payroll
- **Attendance** – shift days from the dialer (first and last call, reported by the QA platform), judged present, late, half day or absent by HR's rules; HR can set any day by hand
- **Shared core** – users and roles, an audit trail, notifications, and self-service for each employee

## Run it with Docker

You need Docker Desktop (or Docker Engine with the Compose plugin).

```bash
cp .env.example .env          # then change POSTGRES_PASSWORD and ADMIN_PASSWORD
docker compose up -d --build
```

Open http://localhost:3000 and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`. The defaults are `admin@wavetech.pk` / `ChangeMe123!`.

To try it with sample people, candidates, leave and 12 months of payroll, set `SEED_DEMO=true` in `.env` **before the first start**. Demo data loads only into an empty database. The demo also creates these sign-ins, all with the password `Demo1234!`:

| Email | Role |
| --- | --- |
| finance@wavetech.pk | Payroll and finance |
| recruiter@wavetech.pk | Recruiter |
| manager@wavetech.pk | Manager (Sales team lead, approves their team's leave) |
| employee@wavetech.pk | Employee self-service |

To start over with an empty database, run `docker compose down -v` and then `docker compose up -d --build`. **The `-v` flag deletes all data and uploaded files.**

### Services

```
web (nginx :3000) ──/api──▶ api (Fastify :8080) ──▶ postgres (:5432)
```

- **api** runs database migrations and the base seed at boot, then serves `/api/v1`. It also runs a leave-accrual job every 6 hours. The job is idempotent: each grant carries a unique reference.
- **web** is the static React build. nginx proxies `/api` to the api container.
- Postgres and the API are published on `127.0.0.1` only. Only the web port is meant to be open.

### Deploy on Coolify

`docker-compose.coolify.yml` is the same stack without host ports or a `.env` file.

1. **Create the resource.** New Resource → Public Repository → `https://github.com/abdulmanan69/hrms`, branch `main`.
2. **Pick the build.** Build Pack *Docker Compose*, location `/docker-compose.coolify.yml`.
3. **Set the domain** on the `web` service, for example `https://hr.example.com`. The domain's DNS must point at the server first, so the HTTPS certificate can be issued.
4. **Set the admin password.** In Environment Variables, set `ADMIN_PASSWORD`, plus `ADMIN_EMAIL`, `COMPANY_NAME` and `COMPANY_SLUG` if they differ from the defaults. Coolify generates the database password.
5. **Deploy.** After each push to `main`, press *Redeploy* in Coolify. To redeploy on every push instead, add the webhook from the resource's *Webhooks* page to the GitHub repository.

### Remote diagnostics

See inside a running instance from any computer, without SSH or a login: problems, errors, logs, API timing and the database. It stays off until a token is set.

1. **Make a token.** On your computer, in this repository, run `node scripts/ops.mjs init --url https://your-hrms`. It writes `.ops.local` (git ignores it) with a new random token.
2. **Give it to the server.** Copy `OPS_TOKEN` from `.ops.local` to the server (Coolify: Environment Variables; Docker: `.env`) and redeploy.
3. **Use it.** Run `node scripts/ops.mjs status`.

| Command | Shows |
| --- | --- |
| `status` | API, database, connection pool, requests, webhooks, integrations and background jobs at a glance, a list of problems, every company's counts, recent starts |
| `errors [--since 24h] [--list]` | warnings and errors grouped by message, with stack traces |
| `logs [--since 1h] [--grep text] [--level warn] [--follow]` | everything logged, live with `--follow` |
| `requests` | API timing per minute and per route, requests slower than 1 s |
| `db` | connections, running queries, table sizes |

- **Logs survive restarts and crashes.** They are kept in the `ops_log` table for 14 days.
- **Secrets are masked** before anything is stored: API keys, passwords, tokens, CNIC and account numbers.
- **No people's records.** The endpoints return only counts, timings and log lines, and there is no SQL endpoint.
- **Limit who can call it.** `OPS_ALLOWED_IPS` (IPs or IPv4 CIDR, comma-separated) restricts access further.

### Backups

Uploaded documents are stored compressed inside Postgres, so one dump holds everything:

```bash
docker compose exec postgres pg_dump -U hrms -Fc hrms > backup-$(date +%F).dump
```

### Files and PDFs

- **Uploads** (employee documents, leave attachments) are compressed when they arrive, then stored in the `stored_files` table:
  - Photos and scans are turned upright, scaled to at most 2,400 px and re-saved as JPEG (or WebP if transparent). A 5 MB phone photo usually becomes 200–400 KB.
  - PDF and Word files are compressed with Brotli and come back byte-for-byte identical. A PDF's internals are never rewritten, so a signed contract keeps a valid digital signature. Most PDFs are already compressed inside, so savings vary from a few percent to over 90% for text-only ones.
  - A file is refused when its content doesn't match its type, for example a renamed `.exe`.
  - Files left on disk by older versions are moved into the database at the next start.
- **Payslip PDFs are never stored.** They are generated from the payslip records whenever someone downloads one, either one payslip or a whole run with a page per payslip, so they always match the data.

## Develop locally

```bash
# database
docker run -d --name hrms-dev-db -e POSTGRES_DB=hrms -e POSTGRES_USER=hrms -e POSTGRES_PASSWORD=hrms -p 127.0.0.1:5433:5432 postgres:16-alpine

# api (http://localhost:8080)
cd server
echo "DATABASE_URL=postgres://hrms:hrms@localhost:5433/hrms" > .env
echo "SEED_DEMO=true" >> .env
npm install
npm run dev

# web (http://localhost:3000, proxies /api to :8080)
cd web
npm install
npm run dev
```

Useful scripts:

- server: `npm run typecheck`, `npm test` (payroll engine tests), `npm run generate` (new migration after a schema change)
- web: `npm run typecheck`, `npm run build`

## Code map

```
server/src/
  db/schema.ts           the whole data model (one file)
  db/seed.ts             roles, first admin, leave types, departments, settings
  db/seedDemo*.ts        sample data (SEED_DEMO=true)
  auth/                  sessions (httpOnly cookie, SHA-256 stored), permissions, guards
  lib/                   errors, audit + notify, dates, uploads, CSV
  services/              shared logic: createEmployee + SIP IDs, leave ledger, payroll engine, settings
  routes/                one file per module, mounted under /api/v1
web/src/
  components/ui.tsx      the UI kit every page uses
  components/Layout.tsx  sidebar, top bar, notifications
  pages/<module>/        pages per module
  lib/                   api client, auth, formatting
  illustrations/         registry.ts (every illustration by name), Illustration.tsx, svg/, LICENSES.md
docs/BUILD_CONTRACT.md   conventions and design rules for adding to a module
```

## Connecting other apps

Other systems (web apps, attendance devices, accounting, scripts) connect under **Admin → Integrations**:

- **API keys:** read and send data through the same REST API the app uses. Each key works in one company, with only the permissions it was given.
- **Webhooks:** signed `POST`s to your URL when something happens (new hire, leave approved, payroll paid …). Failed sends are retried for about a day.
- **Event feed:** `GET /api/v1/integrations/events?after=` for systems that poll.
- **WebSocket:** `/api/v1/ws` for a live connection. Events stream in, and API requests can go over the same socket.

Full details and examples: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md). Events are written in the same transaction as each change, so none are lost or invented. Payloads never include CNIC, bank details or date of birth.

## Companies

One installation serves several companies, and they are kept completely apart: people, SIP IDs, payroll, leave, documents, users, roles, settings, notifications and the audit trail.

- **The database enforces it, not just the code.**
  - Every business row carries `company_id`.
  - Postgres row-level security lets each request see and change only its own company's rows.
  - Each API request runs in one short transaction pinned to the signed-in company, as the restricted role `hrms_app`. Both settings are transaction-local, so they can never carry over to the next request that reuses the same pooled connection.
  - Application code that tries to read data outside a company context fails with an error instead of seeing every company.
- **References can't cross companies.** Links between records use composite keys `(company_id, id)`. So a payslip, leave request, document or manager link can only point at a record of the same company.
- **SIP IDs are per company.** Every company starts at `YYYY-0001`.
- **Super admins** (Admin → Companies) add, rename and disable companies, and switch into any company from the company name at the top of the sidebar. Everyone else only ever sees their own company.
- **One email in several companies** means one account per company; sign-in then asks which company. A wrong password never reveals which companies an email belongs to.
- **Stale browser tabs are refused.** Every request says which company its page was loaded for. If the session has since moved to another company (switched in another tab), the server refuses the request (`company_changed`) and the page reloads. So an old tab can never write into the wrong company.
- **Disabling a company** signs its people out and blocks their sign-in; nothing is deleted.

Cost per request: one extra round trip to the database (`set_config`) inside a transaction. Indexes lead with `company_id`, so the security filter uses them. Background jobs (leave accrual) run one company at a time, each in its own short transaction, and never overlap.

The demo (`SEED_DEMO=true`) creates two companies. `consultant@hrpartners.pk` / `Demo1234!` has an account in both, to show the company picker at sign-in.

## How the key rules are enforced

- **One person, one record.** Hiring a candidate creates the employee from the candidate's details, so nothing is typed twice. The application keeps a link to the new SIP ID.
- **SIP ID** is generated as `YYYY-####` from a per-year counter inside the same transaction. It can't be edited and is never reused.
- **Payroll is computed.** Each payslip is A + B − C. A is split into rate periods for mid-month joiners and increments. B lines are entered by hand and survive recomputes. C covers PF, EOBI, withholding tax, loan installments and manual deductions. Amounts are whole PKR, so the totals always add up exactly.
- **Leavers are paid to their last day.** Someone deactivated mid-month stays on that month's run and is paid up to the deactivation date.
- **Only reviewed figures are approved.** If salary, leave or loans changed after a draft run was computed, approval is refused until the run is recomputed and reviewed again.
- **Leave is a ledger.** Every grant, deduction, reversal and adjustment is a dated row with a running balance. Approved unpaid days reduce section A of that month's payslip.
- **Nothing is hard-deleted.** Employees are deactivated, and candidates and documents are soft-deleted.
- **Every change is audited.** Who made it, when, and the before and after values, shown under Admin → Audit trail.
- **Access is checked on the server.** The UI hides what a role can't use, but every API route checks the permission itself. CNIC, bank details and date of birth are only sent to roles with `employees.sensitive`, or to the employee themself.

## Defaults to confirm before real use

These come from the design's open questions. Each one is a setting, not hard-coded:

| Question | Default | Where to change it |
| --- | --- | --- |
| PF rate | 8.33% of basic | Payroll → Payroll rules |
| EOBI employee share | PKR 370 / month | Payroll → Payroll rules |
| Withholding tax | Finance Act 2025 salaried slabs | Payroll → Payroll rules |
| Proration basis | Calendar days | Payroll → Payroll rules |
| Leave entitlements | Casual 10, Sick 8, Vacation 14 (7 carry forward), Unpaid | Leave → Leave types |
| Weekend and holidays | Saturday and Sunday off, no holidays | Leave → Leave types |
| SIP ID format | `YYYY-####` | `server/src/services/employees.ts` |
