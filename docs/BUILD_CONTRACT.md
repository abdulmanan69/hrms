# Build contract for module work

Written for: engineers (human or agent) building one HRMS module on top of the shared foundation.

Read `WaveTech HRMS — System Design.md` (repo root) for what each module must do. This file says how.

## Layout

```
server/  Fastify 5 + Drizzle ORM + Postgres 16, TypeScript (NodeNext ESM: import paths end in .js)
web/     React 18 + Vite 6 + Tailwind 3 + TanStack Query 5 + react-router 6 + lucide-react + recharts
```

## Ownership: files you may and may not edit

Each module owns only its files. **Do not edit shared files.** If you need a change in one, finish without it and list the exact change you need in your final report.

Shared, read-only for module work:

- `server/src/db/schema.ts` (the whole data model is already there; no migrations from module work)
- `server/src/app.ts`, `server/src/index.ts`, `server/src/config.ts`
- `server/src/auth/*`, `server/src/lib/*`
- `server/src/services/employees.ts`, `leaveLedger.ts`, `people.ts`, `settings.ts`
- `web/src/App.tsx`, `web/src/main.tsx`, `web/src/index.css`, `web/tailwind.config.js`
- `web/src/components/*`, `web/src/lib/*`

Module files:

| Module | Server | Web |
| --- | --- | --- |
| Recruitment | `routes/recruitment.ts`, `services/recruitment*.ts` | `pages/recruitment/*`, `api/recruitment.ts` |
| Employees | `routes/employees.ts`, `services/employee*.ts` (new files, not `employees.ts`) | `pages/employees/*`, `api/employees.ts` |
| Payroll | `routes/payroll.ts`, `services/payroll*.ts` | `pages/payroll/*`, `api/payroll.ts` |
| Leave | `routes/leave.ts`, `services/leave*.ts` (new files, not `leaveLedger.ts`) | `pages/leave/*`, `api/leave.ts` |

The route plugin is already registered in `app.ts` under `/api/v1/<prefix>`: recruitment → `/recruitment`, employees → `/employees`, payroll → `/payroll`, leave → `/leave`. Keep the exported function name (`recruitmentRoutes`, `employeeRoutes`, `payrollRoutes`, `leaveRoutes`).

Pages are already routed in `web/src/App.tsx`. Keep each exported component name exactly as the stub file has it.

## Shared endpoints already built

- `GET /org/people?search=&status=active|pending|inactive|all&limit=` → `{ data: [{ sipId, name, status, departmentName, designationTitle }] }`. Use it for every employee picker.
- `GET /org/departments` → `{ data: [{ id, name, active, headcount }] }`; `GET /org/designations` → `{ data: [{ id, title, departmentId, departmentName, active }] }`; `POST/PATCH /org/departments[/:id]`, `POST/PATCH /org/designations[/:id]` (employees.manage).
- `GET /auth/me`, `GET /notifications`, `GET /users` (users.manage), `GET /audit?entity=&entityId=` (audit.view).
- `GET /dashboard/counts` → `{ pipeline, documents, leave }` (sidebar counts).

## Companies (read before writing any query)

- Use `db` from `db/client.ts` for all business data. In a request it is the company's transaction: Postgres row-level security limits every query to the signed-in company, and `company_id` fills itself in on insert. Never filter by or set `company_id` by hand, and never take a company id from the request.
- `db` throws outside a company context. Background work goes through `runInCompany(companyId, fn)`, one company at a time. `rootDb` (unrestricted) is only for sign-in, sessions, migrations and the platform company list. Inside a request, never use `rootDb`: it would take a second pooled connection.
- A new business table needs a `company_id` column (`companyId()` in schema.ts), references written as composite `(company_id, x)` foreign keys, indexes that lead with `company_id`, and in its migration: `ALTER TABLE … ENABLE ROW LEVEL SECURITY` plus the `company_isolation` policy (copy it from `drizzle/0002_companies.sql`). Add it to `TENANT_TABLES`.
- A route that must run without a company context (rare) declares `config: { platform: true }` and calls `runInCompany` itself.

## Server conventions

- Every handler validates input with zod (`z.object(...).parse(req.body | req.query | req.params)`). Zod errors become 400s automatically.
- Throw `NotFoundError`, `ForbiddenError`, `ValidationError`, `ConflictError` from `lib/errors.ts`. Never leak internals.
- Permissions: `{ preHandler: requirePermission('payroll.view') }` (any-of when several). Catalogue in `auth/permissions.ts`. Self-service endpoints live under `/me` inside your module and use `requireSelf(req)` to get the caller's SIP ID; they need no permission. Use `canReadEmployee` / `assertCanReadEmployee` / `isInTeam` from `auth/plugin.ts` for manager scoping (`team.view`, `leave.approve.team`).
- Writes that change state run in `db.transaction(async (tx) => …)` and call `writeAudit(tx, req, { action, entity, entityId, summary, before, after })`. `summary` is a lowercase verb phrase read after the actor's name, e.g. `moved Zain Abbas to Offer made`, `approved 2 days of casual leave for Hira Siddiqui`. The dashboard activity feed shows `<user name> <summary>`.
- Notify people with `notify(tx, [userIds], { title, body, link })`. Find recipients with `userIdsWithPermission`, `userIdForSip`, `managerUserIdForSip` from `services/people.ts`.
- Lists: `paginationSchema` + `offsetOf` + `pageMeta` from `lib/pagination.ts`; respond `{ data, meta }`. Non-paged lists respond `{ data }`.
- Names: build display names with `fullName()` or `employeeNameSql` from `services/people.ts`. Never store or key on a name.
- Dates: `date` columns are `'YYYY-MM-DD'` strings. Use `lib/dates.ts` (`todayISO`, `daysBetweenInclusive`, `workingDaysBetween`, `monthBounds`, `overlap`, …). Money is whole PKR integers. Leave days are numbers (half days allowed).
- Files: `@fastify/multipart` is registered. `const file = await req.file()` then `saveUpload(file)` from `lib/uploads.ts`; plain form fields sent before the file are on `file.fields`. Serve with `sendUpload(reply, row)` after an access check.
- CSV export: `toCsv` + `sendCsv` from `lib/csv.ts`.
- Soft delete only: employees go `inactive`, candidates get `deleted_at`, documents get `deleted_at`.

## Web conventions

- Data: TanStack Query. `api<T>(path, { method, body, query })`, `upload<T>(path, file, fields)`, `downloadUrl(path, query)` from `lib/api.ts`. Paths are relative to `/api/v1`. Put typed fetchers and response types in your module's `web/src/api/<module>.ts`. Query keys start with the module name, e.g. `['payroll', 'runs']`. After a mutation, invalidate the module's keys and `['nav-counts']` when a sidebar count may change.
- Permissions in UI: `const { user, can } = useAuth()` from `lib/auth.tsx`; hide actions the server would refuse. `user.sipId` is the signed-in person's employee record.
- Formatting: only `lib/format.ts` (`money`, `days`, `date`, `dateRange`, `month`, `dateTime`, `relative`, `label`, `personName`, `fileSize`).
- Components: only `components/ui.tsx` — `PageHeader`, `Card`, `CardHead`, `Stat`, `DetailList`, `SipId`, `Tag`, `StatusTag`, `Avatar`, `Bar`, `Kbd`, `Loading`, `ErrorState`, `EmptyState`, `Pagination`, `Field`, `SearchInput`, `useDebounced`, `FormError`, `Modal`, `ConfirmModal`, `Tabs`, `Segmented`, `toast`, `ICON`. CSS classes from `index.css`: `.card`, `.card-head`, `.card-title`, `.btn-primary`, `.btn-secondary`, `.btn-danger`, `.btn-ghost`, `.btn-sm`, `.icon-btn`, `.input` (inputs, selects, textareas), `.table` + `.th` + `.td`, `tr.row-link`, `.num` (mono tabular figures).
- Every page handles loading (`<Loading />`), error (`<ErrorState message onRetry />`) and empty (`<EmptyState title hint action />`) states.
- Forms show the server's message with `<FormError message={mutation.error?.message} />` and confirm success with `toast('…')`.

## Design rules (non-negotiable)

The look is set: graphite neutrals, one indigo accent (`brand`), Inter + JetBrains Mono, 4px spacing grid. Look at `web/src/pages/Dashboard.tsx` and `web/src/components/Layout.tsx` before you start, and match them.

- Sentence case everywhere. No uppercase tracked labels, no exclamation marks, no trailing periods on labels, buttons or titles, no emoji.
- Titles name the thing (`Payroll runs`, `November 2026`), never greet.
- Icons: lucide only, `{...ICON}` (16px, stroke 1.5), colored `text-ink-3` or inherited. Never colored icons.
- Accent (`brand`) is rare: the primary button, the selected item, the one key figure. Status meaning uses `StatusTag`/`Tag` tones (good, bad, warn, neutral, brand).
- Numbers: `.num` (mono, tabular), right-aligned in table columns, formatted with `lib/format.ts`. SIP IDs always render with `<SipId id=… to=… />` next to a person's name.
- Spacing: page header `mb-8`, sections `mt-6`, card grids `gap-4`, card padding `px-5`. Table cells use `.th`/`.td`. Cards `rounded-xl`, controls `rounded-lg`.
- Motion: only `transition-colors` (already on buttons/rows). No pulsing, bouncing, scaling on hover.
- Copy is plain and specific: `Approve`, `Reject`, `Run payroll`, `Mark as paid`. Empty states say what will appear and how to make it appear.
- Layouts stay real-app sized: full-width content, tables in cards, a detail page = header + tabs or a two-column grid (wide main, narrow side).

## Verify before you finish

1. `cd server && npx tsc -p tsconfig.json --noEmit` and `cd web && npx tsc -p tsconfig.json --noEmit` both pass with zero errors.
2. Exercise your API for real. A dev Postgres runs at `localhost:5433` (user/password/db `hrms`), and `server/.env` points at it. Start the API on your own port so you don't collide with other modules (Git Bash):
   `cd server && API_PORT=<your port> npx tsx src/index.ts > /tmp/<module>-api.log 2>&1 &`
   then sign in with `curl -c /tmp/<module>.cj -H 'content-type: application/json' -d '{"email":"admin@wavetech.pk","password":"ChangeMe123!"}' localhost:<port>/api/v1/auth/login` and call your endpoints with `-b /tmp/<module>.cj`. Stop it when done: `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort <port> -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }"`.
   Other modules may be writing to the same database at the same time; create your own test rows and don't delete others'.
3. Don't run `npm install` (all dependencies are present) and don't touch Docker.
