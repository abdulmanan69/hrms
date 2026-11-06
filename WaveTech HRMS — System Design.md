# WaveTech HRMS — System Design

Nov 5, 2026 · @Wajid Manzoor

This is one internal HR system that carries a person from job applicant to employee on a single record, and drives their payroll and leave from it — four modules (Recruitment, Employee, Payroll, Leave) sitting on a shared core, built for Pakistani payroll rules (CNIC, EOBI, Provident Fund, withholding tax) while supporting US-aligned operations.

## Overview & scope

The three interface documents describe one system seen from three desks, not three systems. A person applies (Recruitment), is hired and becomes staff (Employee Management), and that same record then drives what they are paid (Payroll) and the time they take off (Leave). Building them as one system with a shared person record means a hired candidate's name, contact, and address carry forward with zero re-entry, and every module reads from the same source of truth.

**What it covers**

- **Recruitment / ATS** — applicants, application stages, interviews, and recruiter follow-up.
- **Employee Management** — the active staff register: identity, contact, department, employment status.
- **Payroll & Salary** — per-employee salary structure and a monthly run that computes each payslip (additions, deductions, net).
- **Leave Management** — leave types, running balances, and an approval workflow.
- **Shared core** — one person record, user accounts and roles, document storage, notifications, and an audit trail that sit under all four.

**Design decisions that shape everything below**

1. **One person, many states.** A candidate and an employee are the *same* party record in different states, not two tables. Hiring flips the state and generates the employee code; it does not re-key the person.
2. **The Employee ID (SIP ID) is the system key** — auto-generated, unique, and never reused or edited. `Name` is always derived from First + Middle Initial + Last and is never used as an identifier. (The sample Employee table showed two different people sharing one ID; auto-generation removes that whole class of error.)
3. **Payroll is computed, not typed.** A payslip is the output of (salary structure × that month's attendance), following a fixed A + B − C formula. Nobody hand-enters a net salary.
4. **Leave balance is a ledger, not a number.** Every accrual, application, and adjustment is a dated entry; the "balance" is their running sum. This keeps an audit trail and makes carry-forward and corrections safe.
5. **Nothing is hard-deleted.** People, payslips, and leave records are soft-deleted (flagged inactive), never physically removed — payroll and compliance need history.
6. **Identifiers are stored as text.** Phone, CNIC, and postal code are text fields, not numbers, so leading zeros and formatting survive (a US ZIP like `07087` must not collapse to `7087`).
7. **Every state change is logged.** Stage moves, approvals, salary edits, and status flips write to a single audit trail with who/when/what.

## System map

&#91;embedded content: system map · four modules on a shared core\]

A person enters through the recruitment pipeline; on hire the same record becomes an employee, keyed by SIP ID, which then drives payroll and leave. Approved unpaid leave is the one value that flows back into the payroll calculation.

## Data model

&#91;embedded content: entity relationships · hub = employees (SIP ID)\]

Everything keys off the employees record via SIP ID. The leaf tables are left off to keep the spine readable — interviews and communications hang off their recruitment parents, employee\_documents and loans\_advances off employees, payslip\_line off payslip, and users and the audit trail sit under all of them.

## Recruitment (ATS)

The Recruitment module tracks a candidate from first application to hire, then hands the record to Employee Management. Its backbone is a pipeline the candidate moves through stage by stage, with interviews, follow-ups, and documents attached along the way.

**Pipeline stages** (a candidate's `current_stage` moves down this list; `status` is the headline summary)

1. Application received
2. Screening
3. Interview scheduled
4. Interview completed
5. Feedback received
6. Offer made
7. Offer accepted / rejected
8. Hired → *triggers conversion to an employee record*
9. Onboarding

`status` values for list and dashboard views: **Pending · Screening · Interviewed · Offered · Rejected · Hired**. Reaching **Hired** is the one action that crosses into the Employee module — it generates the SIP ID and copies identity and contact fields forward.

**Key screens**

- **Pipeline board** — candidates as cards in columns by stage; drag to advance. The dashboard counts per stage come straight from this.
- **Candidate profile** — identity, contact, address, application details, stage history, interviews, communications, and documents on one page.
- **Interview panel** — schedule, assign interviewer(s), record outcome and rating.
- **Communication log** — every email, WhatsApp, and call, with the next follow-up date.
- **Dashboard** — totals, count in each stage, recent activity, hires.
- **Search & filter** — by candidate ID, name, position, status, source, and date range.

**Data tables**

*candidates* — the person applying (becomes the shared party record on hire)

| Column | Type | Notes |
| --- | --- | --- |
| candidate\_id | int, PK | Auto-generated unique ID |
| first\_name / middle\_initial / last\_name | text | `Name` is derived, never stored as the key |
| email | text |  |
| phone / alt\_phone | text | Stored as text to keep formatting |
| address1 / address2 / city / state / postal\_code / country | text | postal\_code text, to keep leading zeros |
| gender / date\_of\_birth | text / date |  |
| source | text | e.g. VDAD, TMC100753 |
| notes | text | Security phrase / recruiter remarks |
| created\_at | datetime |  |

*applications* — one row per application (a person can apply more than once)

| Column | Type | Notes |
| --- | --- | --- |
| application\_id | int, PK |  |
| candidate\_id | int, FK → candidates |  |
| position\_applied | text | e.g. Sales Associate |
| application\_date | date |  |
| status | enum | Pending / Screening / Interviewed / Offered / Rejected / Hired |
| current\_stage | enum | The 9 pipeline stages above |
| priority\_rank | int | Optional |
| owner\_recruiter\_id | int, FK → users | Who manages this candidate |
| next\_followup\_date | date | Drives reminders |
| hired\_employee\_id | int, FK → employees | Null until hired; links the two modules |

*interviews*

| Column | Type | Notes |
| --- | --- | --- |
| interview\_id | int, PK |  |
| application\_id | int, FK → applications |  |
| scheduled\_at | datetime |  |
| interviewer\_ids | text / link | One or more users |
| mode | enum | Phone / Online / In-person |
| outcome | enum | Positive / Neutral / Negative |
| rating | int | Optional score |
| feedback\_notes | text |  |
| followup\_action | text | e.g. schedule 2nd round |

*communications* — shared with follow-up; one row per contact

| Column | Type | Notes |
| --- | --- | --- |
| comm\_id | int, PK |  |
| candidate\_id | int, FK → candidates |  |
| channel | enum | Email / WhatsApp / Call |
| direction | enum | Inbound / Outbound |
| subject / summary | text |  |
| occurred\_at | datetime |  |
| user\_id | int, FK → users | Who logged it |

## Employee Management

This is the register of active staff. A record arrives here one way in normal operation — a candidate reaches **Hired** — and from then on the SIP ID identifies that person everywhere in payroll and leave. Direct "add employee" stays available for backfilling existing staff.

**The SIP ID.** Auto-generated, unique, immutable. It is the single key that payroll and leave join on. `Name` is always First + Middle Initial + Last, derived for display, never the key. Generate it with a simple sequence (or a `YYYY-####` pattern if a readable code is wanted) — never by hand, so no two people can collide the way the sample data did.

**Where salary lives.** The employee record holds *identity and employment* facts only. Basic salary and all pay components live in the Payroll module's `salary_structure`, linked by SIP ID. Keeping compensation out of the employee table avoids two copies of the number drifting apart.

**Key screens**

- **Dashboard** — total employees, active vs inactive, quick search by ID/name/department, "Add employee" button.
- **Employee table** — ID, name, department, status, joining date, with edit/deactivate actions; export to CSV/Excel; bulk activate/deactivate.
- **Add / edit form** — the fields below, with employment status and department as dropdowns and a date picker for joining.
- **Employee profile** — full record plus linked documents, current salary structure, and leave balance (read from the other modules).

**Data tables**

*employees*

| Column | Type | Notes |
| --- | --- | --- |
| sip\_id | int/text, PK | Auto-generated, immutable system key |
| source\_candidate\_id | int, FK → candidates | Null for backfilled staff; links back to ATS |
| first\_name / middle\_initial / last\_name | text |  |
| cnic | text | Pakistani ID; text to keep dashes/zeros |
| email / phone / alt\_phone | text |  |
| address1 / address2 / city / state / postal\_code / country | text |  |
| department\_id | int, FK → departments |  |
| designation\_id | int, FK → designations |  |
| employment\_status | enum | Probation / Contractual / Permanent |
| date\_of\_joining | date |  |
| status | enum | Active / Inactive (soft-delete) |
| bank\_name / account\_no | text | For payroll disbursement |
| remarks | text |  |

*departments* — department\_id (PK), name

*designations* — designation\_id (PK), title, department\_id (FK, optional)

*employee\_documents*

| Column | Type | Notes |
| --- | --- | --- |
| doc\_id | int, PK |  |
| sip\_id | int, FK → employees |  |
| type | enum | Resume / CNIC / Offer letter / Contract / Other |
| file\_url | text | Stored file reference |
| uploaded\_at | datetime |  |

Flagged in the sample as commonly missing at hire: **CNIC** and signed documents. The form should mark these required-before-active so a record can't go live without them.

## Payroll & salary engine

A payslip is computed, never typed. The engine takes an employee's salary structure and that month's attendance, and produces the three sections your salary sheet already defines — **A (gross earned), B (additions), C (deductions)** — and the net:

```latex
\text{Net} = A + B - C
```

- **A — Gross earned.** The monthly gross (Basic + House Rent + Medical + any other structural allowance), scaled to the days actually payable this month.
- **B — Additions.** One-off or variable pay entered per run: Incentive, Overtime, Arrears, Stipend, Traveling Allowance, Bonus, Gratuity, Internet/Mobile, Waived amount.
- **C — Deductions.** Provident Fund, EOBI, Withholding Tax, Loan/Advance deduction, unpaid-days amount (if you prorate by deduction rather than by reduced gross), Other.

**Proration — the part that needs care.** Two situations change the days that are payable: a **mid-month joiner** (days before joining aren't paid) and a **mid-month increment** (part of the month at the old rate, part at the new). The engine splits the month into rate periods and sums each:

```latex
A = \sum_{p}\left(\frac{\text{MonthlySalary}_p}{\text{DaysOfMonth}}\right)\times \text{PaidDays}_p, \qquad \text{PaidDays}_p = \text{Days}_p - \text{NotJoined}_p - \text{Unpaid}_p
```

For a normal full month there is one period and `PaidDays = DaysOfMonth`. An increment creates two periods, which is exactly why the salary sheet carries *Current Salary* and *New Salary* with their own *Days Expected* and *Unpaid Days* columns. In the data model, the two periods are simply two `salary_structure` rows with different `effective_from` dates — history is kept automatically.

**Worked example — mid-month increment**

Gross raised from 50,000 to 60,000, effective 16 July; July has 31 calendar days; no unpaid days.

| Step | Value |
| --- | --- |
| Daily rate, old (50,000 ÷ 31) | 1,612.90 |
| Daily rate, new (60,000 ÷ 31) | 1,935.48 |
| Paid days at old rate (1–15 Jul) | 15 |
| Paid days at new rate (16–31 Jul) | 16 |
| **A — gross earned** (15×1,612.90 + 16×1,935.48) | **55,161** |
| B — additions (Overtime 3,000 + Incentive 5,000) | 8,000 |
| C — deductions (PF 3,000 + EOBI 370 + WHT 1,200 + Loan 2,000) | 6,570 |
| **Net (A + B − C)** | **56,591** |

**Data tables**

*salary\_structure* — one row per rate period; an increment adds a new row

| Column | Type | Notes |
| --- | --- | --- |
| structure\_id | int, PK |  |
| sip\_id | int, FK → employees |  |
| effective\_from | date | Increment date = the new row's start |
| basic\_salary / house\_rent / medical\_allowance / petrol\_allowance | number | Breakdown of gross |
| gross\_salary | number | Sum of the above |
| pf\_applicable / eobi\_applicable / wht\_applicable | bool | Drives section C |
| is\_current | bool | Latest row for the employee |

*payroll\_run* — one per month

| Column | Type | Notes |
| --- | --- | --- |
| run\_id | int, PK |  |
| period\_month | text | e.g. 2026-07 |
| days\_of\_month / working\_days | int | Proration basis |
| status | enum | Draft / Approved / Paid |
| created\_by / approved\_by | int, FK → users |  |

*payslip* — one per employee per run

| Column | Type | Notes |
| --- | --- | --- |
| payslip\_id | int, PK |  |
| run\_id | int, FK → payroll\_run |  |
| sip\_id | int, FK → employees |  |
| current\_salary\_days / new\_salary\_days | int | Paid days per rate period |
| not\_joined\_days / unpaid\_days | int | Reduce payable days |
| gross\_a / total\_additions\_b / total\_deductions\_c | number | The three sections |
| net\_total | number | A + B − C |

*payslip\_line* — the itemized breakdown behind A/B/C

| Column | Type | Notes |
| --- | --- | --- |
| line\_id | int, PK |  |
| payslip\_id | int, FK → payslip |  |
| section | enum | A / B / C |
| component | text | Basic, Overtime, EOBI, … |
| amount | number |  |

*loans\_advances* — a ledger so Loan/Advance given, deducted per run, and waived always reconciles to a running balance (sip\_id, type, amount, date, run\_id, balance).

## Leave Management

Employees apply for leave, a manager approves or rejects, and the balance updates. The balance is kept as a **ledger** — every grant and deduction is a dated entry, and the number shown is their running sum — so corrections and year-end carry-forward stay auditable.

**Leave types** — Sick, Casual, Vacation, Unpaid, Other. Each carries an annual entitlement and a paid/unpaid flag.

**Approval workflow**

1. Employee submits an application: type, start date, end date (total days auto-calculated), reason, optional attachment.
2. Status is **Pending**; the approver is notified.
3. Manager **approves** or **rejects**, with an optional comment.
4. On approval, a deduction entry is written to that employee's ledger and the applicant is notified.

**The link to payroll.** When approved leave is of an **Unpaid** type (or exceeds a paid balance), those days become the `unpaid_days` the payroll engine uses to reduce section A. This is the one place Leave and Payroll touch, and it's why the two must share the SIP ID and the same month boundaries.

**Data tables**

*leave\_types*

| Column | Type | Notes |
| --- | --- | --- |
| leave\_type\_id | int, PK |  |
| name | text | Sick / Casual / Vacation / Unpaid / Other |
| annual\_entitlement\_days | number | e.g. 15 |
| is\_paid | bool | Unpaid types flow to payroll |
| accrual\_rule | text | Annual grant, monthly accrual, etc. |

*leave\_ledger* — the running balance, one row per movement

| Column | Type | Notes |
| --- | --- | --- |
| entry\_id | int, PK |  |
| sip\_id | int, FK → employees |  |
| leave\_type\_id | int, FK → leave\_types |  |
| entry\_type | enum | Accrual / Application / Adjustment / Carry-forward |
| days | number | Signed: + grant, − taken |
| entry\_date | date |  |
| reference | int | application\_id or payroll run |
| balance\_after | number | Running balance for quick display |

*leave\_applications*

| Column | Type | Notes |
| --- | --- | --- |
| application\_id | int, PK |  |
| sip\_id | int, FK → employees |  |
| leave\_type\_id | int, FK → leave\_types |  |
| start\_date / end\_date | date |  |
| total\_days | number | Auto-calculated |
| reason | text |  |
| attachment\_url | text | Medical note, etc. |
| status | enum | Pending / Approved / Rejected |
| approver\_id | int, FK → users |  |
| decision\_comment | text |  |
| decided\_at | datetime |  |

## Roles & permissions

Access is role-based. Payroll figures and CNICs are the sensitive data, so Finance and HR see them while recruiters and managers do not. Every user has one or more roles; the employee self-service role is scoped to their own record only.

| Role | Recruitment | Employee records | Payroll | Leave | Users & settings |
| --- | --- | --- | --- | --- | --- |
| HR / System Admin | Full | Full | Full | Full | Full |
| Recruiter | Full | Read | — | — | — |
| Payroll / Finance | — | Read | Full (run, approve) | Read | — |
| Manager / Team Lead | — | Read (own team) | — | Approve (own team) | — |
| Employee (self-service) | — | Own profile | Own payslips | Apply + own balance | — |

*users* — user\_id (PK), sip\_id (FK, null for non-staff accounts), username, password\_hash, role(s), is\_active. A single *audit\_trail* table (user\_id, action, entity, entity\_id, before/after, timestamp) backs every module.

## Tech stack & build phases

**Recommended stack** — chosen to lean on Python, which you already use for your data pipelines.

- **Backend: Django** (Python). Its ORM, built-in auth, group-based permissions, and auto admin panel cover most of this system's CRUD and RBAC out of the box — you build the payroll/leave logic, not the plumbing. Add Django REST Framework only if you want a separate front-end or mobile client later.
- **Database: PostgreSQL.** Relational fits this model cleanly; strong with the date math payroll needs. (MySQL is fine if that's what your stack already runs.)
- **Front end: server-rendered Django templates** to start, with a light JS layer for the drag-to-advance pipeline board. Move to React only if the UI grows beyond that.
- **Payroll engine: a Python module**, so you can reuse `openpyxl` to export payslips and the monthly sheet to Excel, and a library like WeasyPrint for PDF payslips.
- **Auth & audit: Django auth groups** for the roles table above, plus a model-level audit log (e.g. django-simple-history) feeding the audit trail.

**Build phases** — ordered by dependency and business value, not by the order the documents were written.

| Phase | Scope | Why here |
| --- | --- | --- |
| 1 — Foundation | Person/employee core, users & RBAC, departments, designations, audit trail | Everything else references these |
| 2 — Employee Management | Register, forms, documents, import existing staff | The register must exist before pay and leave |
| 3 — Payroll engine | Salary structure, monthly run, A+B−C calc, proration, Excel/PDF export | Highest operational value; runs every month |
| 4 — Leave Management | Types, ledger, approvals; wire unpaid days into payroll | Depends on employees; feeds payroll |
| 5 — Recruitment / ATS | Pipeline, interviews, follow-up, convert-to-employee | Can run last; hires can be backfilled meanwhile |

Starting with Employee + Payroll gets the part that runs every month working first; Recruitment can be added without disturbing it, since the convert-to-employee step just writes into the register that already exists.

## Data hygiene & open questions

**Spotted in the sample data** — small things, but they shape the schema:

- The candidate **Phone Number** field held an address (`1221 SUMMIT AVE, Union City, NJ`). Phone and address must be separate, validated fields.
- Postal code `2015` for Union City, NJ is almost certainly `07087` with the leading zero lost — the classic spreadsheet number cast. This is exactly why postal codes, phones, and CNIC are **text**.
- Two different people (Domingo Santana, Lee Fisher) shared Employee ID `20260070104`. Auto-generation makes this impossible.
- Candidates carry **US addresses** while the employee/payroll side is **Pakistani** (CNIC, EOBI, Provident Fund, WHT). Worth confirming who each module is really about (see first question below), because it decides which identity fields are required where.

**Decisions to confirm before build**

- **Who is a candidate vs an employee?** Are applicants your US-facing agents, or the Pakistani staff being hired? This sets whether the ATS needs SSN/US fields and the employee side needs CNIC — or both.
- **Proration basis:** per calendar day of the month, or per working day? It changes the daily rate in section A.
- **PF / EOBI / WHT rules:** fixed percentages, slabs, or thresholds? The engine needs the exact formula for each.
- **Leave policy:** entitlement per type, annual grant vs monthly accrual, and carry-forward rules.
- **SIP ID format:** a plain sequence, or a readable `YYYY-####` code?
- **WhatsApp logging:** manual entries, or an API integration?
- **Currency:** payroll in PKR throughout, with client-facing amounts handled elsewhere — confirm there's no multi-currency payslip need.
