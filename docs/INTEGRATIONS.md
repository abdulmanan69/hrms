# Connecting other systems to WaveTech HRMS

Written for: developers of other apps (web apps, mobile apps, attendance devices, accounting or bank tools, scripts) that need to read HR data, send data in, or react to changes.

There are four ways in. They all use the same permissions and stay inside one company.

| Need | Use |
| --- | --- |
| Read or send data on demand | REST API with an API key |
| Be told when something happens | Webhooks (we POST to your URL) |
| Check for changes on a schedule, or behind a firewall that blocks incoming calls | Event feed (you poll) |
| Live two-way connection | WebSocket |

An HR admin creates keys and webhooks under **Admin → Integrations**. The page's *Developer guide* tab has the same examples, with your server address filled in.

## 1. API keys

- **Format:** `hrms_<8 hex>_<40 hex>`. Send it on every request as `Authorization: Bearer hrms_…`.
- **Scope:** a key works in **one company**, with **only the permissions ticked when it was created**, and never more than its creator holds.
  - `employees.view` reads staff.
  - `leave.manage` applies for leave on someone's behalf.
  - `payroll.view` reads payroll.
  - The full list is on the key form.
- **Storage:** the full key is shown once and only its SHA-256 is stored. A lost key is revoked and replaced, never recovered.
- **Revoking** takes effect immediately, including for open WebSocket connections.
- **Rate limit:** 600 requests per minute per key.
- **Expiry:** keys can expire after 90 days, after a year, or never.
- **Audit trail:** changes made with a key are recorded under the person who created it, ending with `via API key "<name>"`.

## 2. REST API

Base URL: `https://<your HRMS host>/api/v1`. Every screen in the app uses this same API.

- **Lists:** take `page` and `pageSize` (up to 200) and return `{ "data": [...], "meta": { page, pageSize, total, totalPages } }`.
- **Errors:** return a 4xx status with `{ "error": "<code>", "message": "<readable>" }`. Validation errors add `details` per field.
- **Dates** are `YYYY-MM-DD`, **money** is whole PKR, and **people** are identified by SIP ID (`2026-0004`).

Common endpoints:

| Method and path | Permission | What |
| --- | --- | --- |
| `GET /employees?status=active&search=` | employees.view | Staff list |
| `GET /employees/:sipId` | employees.view | One employee |
| `POST /employees` | employees.manage | Add an employee |
| `GET /org/departments`, `GET /org/designations` | any | Lookups |
| `GET /recruitment/candidates`, `POST /recruitment/candidates` | recruitment.view / .manage | Candidates |
| `POST /recruitment/applications/:id/hire` | recruitment.manage | Hire (creates the employee) |
| `GET /leave/applications?status=pending` | leave.view | Leave requests |
| `POST /leave/applications` | leave.manage (for others) | Apply for leave |
| `POST /leave/applications/:id/approve` | leave.approve | Approve |
| `GET /leave/balances` | leave.view | Balances |
| `GET /payroll/runs`, `GET /payroll/runs/:id` | payroll.view | Payroll runs and payslips |
| `GET /payroll/runs/:id/export.csv` | payroll.view | Run as CSV |
| `GET /payroll/payslips/:id/pdf` | payroll.view | Payslip PDF (generated on request) |
| `GET /integrations/events?after=` | any | Event feed (below) |

```bash
curl -H "Authorization: Bearer $HRMS_API_KEY" "https://hrms.example.com/api/v1/employees?status=active"
```

## 3. Webhooks

You give a URL and pick events. When one happens, we `POST` JSON to it:

```
POST /your/hook
Content-Type: application/json
X-HRMS-Event: leave_application.approved
X-HRMS-Delivery: 812
X-HRMS-Timestamp: 1793930000
X-HRMS-Signature: sha256=<hex>

{ "id": 5121, "type": "leave_application.approved", "occurredAt": "2026-11-06T10:42:00.000Z",
  "data": { "entity": "leave_application", "id": "14", "summary": "approved 2 days …",
            "actor": { "userId": 3, "name": "…", "apiKey": null }, "record": { … } } }
```

- **Verify every request.** Compute HMAC-SHA256 of `"<X-HRMS-Timestamp>.<raw body>"` with the webhook's signing secret. It must equal the hex after `sha256=` in `X-HRMS-Signature`. Also reject timestamps older than 5 minutes. The Developer guide tab has Node.js and Python code for this.
- **Answer 2xx within 10 seconds.** Do slow work after answering.
- **Retries:** anything else is retried after 30 s, 1 min, 2 min, 4 min … for 8 attempts (about a day).
  - Every attempt is listed under the webhook's *Deliveries*.
  - A failed delivery can be sent again by hand.
- **The same event can arrive twice.** Use `id` to handle each one once.
- **Payloads never contain CNIC, bank details or date of birth.** Fetch the record with your key if you need it.
- **Address limits:** URLs must be `https://` and must not resolve to a private or internal address. That blocks reaching the database or cloud metadata through a webhook. To send to apps on your own network (or plain `http://`), set `WEBHOOK_ALLOW_PRIVATE=true` in `.env`.
- **Signing secret:** shown once. *New secret* on the webhook replaces it.

## 4. Event feed (polling)

```
GET /api/v1/integrations/events?after=<last id>&limit=100&types=employee.*,leave_application.approved
→ { "data": [ { id, type, occurredAt, data } ... ], "next": <id to pass as after> }
```

- **Start** with `after=0`, or with the newest id from your last run.
- **Contents:** only events from modules your key can read. Events are kept for 30 days.

## 5. WebSocket

`wss://<host>/api/v1/ws`

**Signing in**, choose one:

- **Servers:** send the `Authorization: Bearer hrms_…` header.
- **Pages served by the HRMS itself:** the session cookie is enough.
- **Browser apps on another site:** call `POST /api/v1/realtime/ticket` (signed in) to get `{ ticket }`, then connect to `/api/v1/ws?ticket=…`. A ticket works once, within 30 seconds, so no key ever appears in a URL or log.

**Messages** (JSON, one per frame):

```jsonc
// you send
{ "type": "subscribe", "events": ["leave_application.*", "employee.created"], "since": 5100 }
{ "type": "request", "id": "1", "method": "GET", "path": "/employees?pageSize=5" }
{ "type": "request", "id": "2", "method": "POST", "path": "/leave/applications", "body": { … } }
{ "type": "ping" }

// you receive
{ "type": "welcome", "company": { "id": 1, "name": "WaveTech" }, "permissions": [ … ], "lastEventId": 5120 }
{ "type": "event", "id": 5121, "event": "leave_application.approved", "occurredAt": "…", "data": { … } }
{ "type": "response", "id": "1", "status": 200, "body": { "data": [ … ], "meta": { … } } }
{ "type": "error", "message": "…" }
```

- **Requests over the socket** go through the normal API with the connection's own credentials: same permissions, rate limit and audit trail. File downloads (CSV, PDF) are HTTP only.
- **Default subscription:** everything the connection may see (`"*"`).
- **Missed events:** subscribe with `since` set to the last id you handled, and anything missed while disconnected (up to 500 events, 30 days) is replayed first.
- **Liveness:** the server pings every 30 s and drops connections that don't answer.
- **Access re-checks:** access is checked again every minute. A revoked key or a signed-out session closes with code `4401`.
- **Limits:** 20 connections per key or session, 1,000 per server, 256 KB per message.

## 6. Connector API: systems that know people by their own user names

Many systems (a dialer, a door-access system, a ticket desk) know staff by their own account names, not SIP IDs. HRMS keeps a link per person and system: *Connected accounts* on the employee profile, or in bulk under **Admin → Integrations → VICIdial**. Every event about a person then carries `data.links`, e.g. `{ "vicidial": [{ "externalId": "agent1043", "context": "" }] }`.

| Method and path | Permission | What |
| --- | --- | --- |
| `GET /connect/:system/people?ids=a,b&context=` | employees.view (+ leave.view for leave) | The person behind each account: name, SIP ID, department, designation, manager (with their accounts), active or left, on leave today and in the next 30 days |
| `GET /connect/:system/roster?status=active\|all` | employees.view | Everyone, with their accounts in that system |
| `POST /connect/:system/suggest` `{ accounts: [{ externalId, fullName, context? }] }` | employees.view | Best name matches for unlinked accounts (nothing saved) |
| `PUT /connect/:system/links` `{ links: [{ sipId, externalId, context? }] }` | employees.manage | Link accounts (bulk, up to 2,000) |
| `DELETE /connect/:system/links` `{ externalId, context? }` | employees.manage | Unlink |
| `POST /connect/:system/metrics` `{ items: [{ externalId \| sipId, metric, period, value, unit?, details? }] }` | metrics.write | Report figures per person: `period` is `YYYY-MM` or a date; the same person, metric and period replaces the value. Unknown accounts come back in `unknown` |
| `GET /connect/employees/:sipId` | can read the employee | One person's accounts and latest figures |

`context` tells apart equal user names in several instances of the same system (e.g. two dialers); leave it empty otherwise.

The VICIdial QA platform has a ready-made kit using all of this: [integrations/vicidial](../integrations/vicidial/README.md).

## Event types

| Event | When |
| --- | --- |
| `employee.created` / `updated` / `activated` / `deactivated` / `reactivated` | Staff register changes (hiring creates `employee.created`) |
| `employee_document.uploaded` / `deleted` | Documents |
| `candidate.created` / `updated`, `application.stage_changed` / `rejected`, `interview.created` / `updated` | Recruitment |
| `leave_application.created` / `approved` / `rejected` / `cancelled`, `leave_ledger.adjusted` | Leave |
| `payroll_run.created` / `approved` / `paid` / `reopened`, `salary_structure.created`, `loan.created` | Payroll |
| `department.*`, `designation.*`, `user.*`, `role.*`, `webhook.*`, `api_key.*` | Setup and admin |

Patterns: `*` (everything), `employee.*` (one module), or an exact type.

Every audited change in the app produces an event, so new features add new event types automatically, named `<entity>.<action in past tense>`.

## How it stays safe and light

- **Events are reliable.** Each event is written in the **same database transaction** as the change it describes. A change that fails never sends an event, and a committed change always has one.
- **Webhooks don't slow the app down.** They are sent by a background worker outside any request:
  - at most 4 in flight
  - a 10-second timeout
  - leases on each delivery, so several API servers never send the same one twice
  - nothing waits on a slow receiver.
- **The WebSocket poller is cheap.** It reads new events once a second, only while someone is connected, using an indexed query.
- **Isolation as everywhere else.** Keys, webhooks, deliveries and events are company-scoped, with the same row-level security as all business data. Requests can't read webhook secrets or key hashes at all.
