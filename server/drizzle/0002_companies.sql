-- 1. Companies. An existing install becomes company 1, named from its settings.
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
INSERT INTO companies (name, slug) SELECT coalesce((SELECT value->>'name' FROM settings WHERE key = 'company'), 'WaveTech'), 'wavetech' WHERE EXISTS (SELECT 1 FROM users);
--> statement-breakpoint
SELECT set_config('app.company_id', coalesce((SELECT min(id) FROM companies), 0)::text, true);

-- 2. Drop single-company keys (foreign keys first, then what they depended on).
--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_department_id_departments_id_fk";
--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_hired_sip_id_employees_sip_id_fk";
--> statement-breakpoint
ALTER TABLE "communications" DROP CONSTRAINT "communications_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE "designations" DROP CONSTRAINT "designations_department_id_departments_id_fk";
--> statement-breakpoint
ALTER TABLE "employee_documents" DROP CONSTRAINT "employee_documents_sip_id_employees_sip_id_fk";
--> statement-breakpoint
ALTER TABLE "employees" DROP CONSTRAINT "employees_source_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE "employees" DROP CONSTRAINT "employees_department_id_departments_id_fk";
--> statement-breakpoint
ALTER TABLE "employees" DROP CONSTRAINT "employees_designation_id_designations_id_fk";
--> statement-breakpoint
ALTER TABLE "employees" DROP CONSTRAINT "employees_manager_sip_id_employees_sip_id_fk";
--> statement-breakpoint
ALTER TABLE "interviews" DROP CONSTRAINT "interviews_application_id_applications_id_fk";
--> statement-breakpoint
ALTER TABLE "leave_applications" DROP CONSTRAINT "leave_applications_sip_id_employees_sip_id_fk";
--> statement-breakpoint
ALTER TABLE "leave_applications" DROP CONSTRAINT "leave_applications_leave_type_id_leave_types_id_fk";
--> statement-breakpoint
ALTER TABLE "leave_ledger" DROP CONSTRAINT "leave_ledger_sip_id_employees_sip_id_fk";
--> statement-breakpoint
ALTER TABLE "leave_ledger" DROP CONSTRAINT "leave_ledger_leave_type_id_leave_types_id_fk";
--> statement-breakpoint
ALTER TABLE "loans_advances" DROP CONSTRAINT "loans_advances_sip_id_employees_sip_id_fk";
--> statement-breakpoint
ALTER TABLE "loans_advances" DROP CONSTRAINT "loans_advances_run_id_payroll_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "payslip_lines" DROP CONSTRAINT "payslip_lines_payslip_id_payslips_id_fk";
--> statement-breakpoint
ALTER TABLE "payslips" DROP CONSTRAINT "payslips_run_id_payroll_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "payslips" DROP CONSTRAINT "payslips_sip_id_employees_sip_id_fk";
--> statement-breakpoint
ALTER TABLE "salary_structures" DROP CONSTRAINT "salary_structures_sip_id_employees_sip_id_fk";
--> statement-breakpoint
ALTER TABLE "stage_history" DROP CONSTRAINT "stage_history_application_id_applications_id_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_role_id_roles_id_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_sip_id_employees_sip_id_fk";
--> statement-breakpoint
ALTER TABLE "departments" DROP CONSTRAINT "departments_name_unique";
--> statement-breakpoint
ALTER TABLE "leave_types" DROP CONSTRAINT "leave_types_name_unique";
--> statement-breakpoint
ALTER TABLE "payroll_runs" DROP CONSTRAINT "payroll_runs_period_month_unique";
--> statement-breakpoint
ALTER TABLE "roles" DROP CONSTRAINT "roles_name_unique";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_email_unique";
--> statement-breakpoint
DROP INDEX "users_sip_id_uq";
--> statement-breakpoint
DROP INDEX "applications_stage_idx";
--> statement-breakpoint
DROP INDEX "applications_candidate_idx";
--> statement-breakpoint
DROP INDEX "applications_followup_idx";
--> statement-breakpoint
DROP INDEX "audit_entity_idx";
--> statement-breakpoint
DROP INDEX "audit_created_idx";
--> statement-breakpoint
DROP INDEX "candidates_name_idx";
--> statement-breakpoint
DROP INDEX "communications_candidate_idx";
--> statement-breakpoint
DROP INDEX "employee_documents_sip_idx";
--> statement-breakpoint
DROP INDEX "employees_dept_idx";
--> statement-breakpoint
DROP INDEX "employees_status_idx";
--> statement-breakpoint
DROP INDEX "employees_manager_idx";
--> statement-breakpoint
DROP INDEX "employees_name_idx";
--> statement-breakpoint
DROP INDEX "interviews_app_idx";
--> statement-breakpoint
DROP INDEX "interviews_when_idx";
--> statement-breakpoint
DROP INDEX "leave_apps_sip_idx";
--> statement-breakpoint
DROP INDEX "leave_apps_status_idx";
--> statement-breakpoint
DROP INDEX "leave_apps_dates_idx";
--> statement-breakpoint
DROP INDEX "leave_ledger_sip_type_idx";
--> statement-breakpoint
DROP INDEX "leave_ledger_reference_uq";
--> statement-breakpoint
DROP INDEX "loans_sip_idx";
--> statement-breakpoint
DROP INDEX "notifications_user_idx";
--> statement-breakpoint
DROP INDEX "payslip_lines_payslip_idx";
--> statement-breakpoint
DROP INDEX "payslips_run_sip_uq";
--> statement-breakpoint
DROP INDEX "payslips_sip_idx";
--> statement-breakpoint
DROP INDEX "salary_structures_period_uq";
--> statement-breakpoint
DROP INDEX "stage_history_app_idx";
--> statement-breakpoint
ALTER TABLE "employees" DROP CONSTRAINT "employees_pkey";
--> statement-breakpoint
ALTER TABLE "settings" DROP CONSTRAINT "settings_pkey";
--> statement-breakpoint
ALTER TABLE "sip_counters" DROP CONSTRAINT "sip_counters_pkey";

-- 3. Add company_id. The default reads app.company_id, so existing rows land in company 1. Sessions are cleared: everyone signs in again once.
--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_trail" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "designations" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "employee_documents" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "leave_applications" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "leave_ledger" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "leave_types" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "loans_advances" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "salary_structures" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "sip_counters" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "stage_history" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "stored_files" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_super_admin" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DELETE FROM "sessions";
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "company_id" integer NOT NULL;

-- 4. Company-scoped keys.
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_pk" PRIMARY KEY("company_id","sip_id");
--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_pk" PRIMARY KEY("company_id","key");
--> statement-breakpoint
ALTER TABLE "sip_counters" ADD CONSTRAINT "sip_counters_pk" PRIMARY KEY("company_id","year");
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_company_id_uq" UNIQUE("company_id","id");
--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_company_id_uq" UNIQUE("company_id","id");
--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_company_id_uq" UNIQUE("company_id","id");
--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_company_name_uq" UNIQUE("company_id","name");
--> statement-breakpoint
ALTER TABLE "designations" ADD CONSTRAINT "designations_company_id_uq" UNIQUE("company_id","id");
--> statement-breakpoint
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_company_id_uq" UNIQUE("company_id","id");
--> statement-breakpoint
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_company_name_uq" UNIQUE("company_id","name");
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_company_id_uq" UNIQUE("company_id","id");
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_company_month_uq" UNIQUE("company_id","period_month");
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_company_id_uq" UNIQUE("company_id","id");
--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_company_id_uq" UNIQUE("company_id","id");
--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_company_name_uq" UNIQUE("company_id","name");
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_company_email_uq" UNIQUE("company_id","email");
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_company_sip_uq" UNIQUE("company_id","sip_id");

-- 5. Composite references: a row can only point at rows of its own company.
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_candidate_fk" FOREIGN KEY ("company_id","candidate_id") REFERENCES "public"."candidates"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_department_fk" FOREIGN KEY ("company_id","department_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_hired_fk" FOREIGN KEY ("company_id","hired_sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_trail" ADD CONSTRAINT "audit_trail_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_candidate_fk" FOREIGN KEY ("company_id","candidate_id") REFERENCES "public"."candidates"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "designations" ADD CONSTRAINT "designations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "designations" ADD CONSTRAINT "designations_department_fk" FOREIGN KEY ("company_id","department_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_candidate_fk" FOREIGN KEY ("company_id","source_candidate_id") REFERENCES "public"."candidates"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_fk" FOREIGN KEY ("company_id","department_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_designation_fk" FOREIGN KEY ("company_id","designation_id") REFERENCES "public"."designations"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_manager_fk" FOREIGN KEY ("company_id","manager_sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_application_fk" FOREIGN KEY ("company_id","application_id") REFERENCES "public"."applications"("company_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_applications" ADD CONSTRAINT "leave_applications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_applications" ADD CONSTRAINT "leave_apps_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_applications" ADD CONSTRAINT "leave_apps_type_fk" FOREIGN KEY ("company_id","leave_type_id") REFERENCES "public"."leave_types"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_ledger" ADD CONSTRAINT "leave_ledger_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_ledger" ADD CONSTRAINT "leave_ledger_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_ledger" ADD CONSTRAINT "leave_ledger_type_fk" FOREIGN KEY ("company_id","leave_type_id") REFERENCES "public"."leave_types"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loans_advances" ADD CONSTRAINT "loans_advances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loans_advances" ADD CONSTRAINT "loans_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loans_advances" ADD CONSTRAINT "loans_run_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."payroll_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_payslip_fk" FOREIGN KEY ("company_id","payslip_id") REFERENCES "public"."payslips"("company_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_run_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."payroll_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sip_counters" ADD CONSTRAINT "sip_counters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_application_fk" FOREIGN KEY ("company_id","application_id") REFERENCES "public"."applications"("company_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_fk" FOREIGN KEY ("company_id","role_id") REFERENCES "public"."roles"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE no action;

-- 6. Indexes lead with company_id, matching the row-security filter.
--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");
--> statement-breakpoint
CREATE INDEX "applications_stage_idx" ON "applications" USING btree ("company_id","current_stage");
--> statement-breakpoint
CREATE INDEX "applications_candidate_idx" ON "applications" USING btree ("company_id","candidate_id");
--> statement-breakpoint
CREATE INDEX "applications_followup_idx" ON "applications" USING btree ("company_id","next_followup_date");
--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_trail" USING btree ("company_id","entity","entity_id");
--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_trail" USING btree ("company_id","id");
--> statement-breakpoint
CREATE INDEX "candidates_name_idx" ON "candidates" USING btree ("company_id","last_name","first_name");
--> statement-breakpoint
CREATE INDEX "communications_candidate_idx" ON "communications" USING btree ("company_id","candidate_id");
--> statement-breakpoint
CREATE INDEX "employee_documents_sip_idx" ON "employee_documents" USING btree ("company_id","sip_id");
--> statement-breakpoint
CREATE INDEX "employees_dept_idx" ON "employees" USING btree ("company_id","department_id");
--> statement-breakpoint
CREATE INDEX "employees_status_idx" ON "employees" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX "employees_manager_idx" ON "employees" USING btree ("company_id","manager_sip_id");
--> statement-breakpoint
CREATE INDEX "employees_name_idx" ON "employees" USING btree ("company_id","last_name","first_name");
--> statement-breakpoint
CREATE INDEX "interviews_app_idx" ON "interviews" USING btree ("company_id","application_id");
--> statement-breakpoint
CREATE INDEX "interviews_when_idx" ON "interviews" USING btree ("company_id","scheduled_at");
--> statement-breakpoint
CREATE INDEX "leave_apps_sip_idx" ON "leave_applications" USING btree ("company_id","sip_id");
--> statement-breakpoint
CREATE INDEX "leave_apps_status_idx" ON "leave_applications" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX "leave_apps_dates_idx" ON "leave_applications" USING btree ("company_id","start_date","end_date");
--> statement-breakpoint
CREATE INDEX "leave_ledger_sip_type_idx" ON "leave_ledger" USING btree ("company_id","sip_id","leave_type_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "leave_ledger_reference_uq" ON "leave_ledger" USING btree ("company_id","sip_id","leave_type_id","reference");
--> statement-breakpoint
CREATE INDEX "loans_sip_idx" ON "loans_advances" USING btree ("company_id","sip_id","id");
--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("company_id","user_id","read_at");
--> statement-breakpoint
CREATE INDEX "payslip_lines_payslip_idx" ON "payslip_lines" USING btree ("company_id","payslip_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payslips_run_sip_uq" ON "payslips" USING btree ("company_id","run_id","sip_id");
--> statement-breakpoint
CREATE INDEX "payslips_sip_idx" ON "payslips" USING btree ("company_id","sip_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "salary_structures_period_uq" ON "salary_structures" USING btree ("company_id","sip_id","effective_from");
--> statement-breakpoint
CREATE INDEX "stage_history_app_idx" ON "stage_history" USING btree ("company_id","application_id");

-- 7. Row-level security. Requests run as hrms_app (SET LOCAL ROLE per transaction) and see only rows of app.company_id. The owner (migrations, sign-in, platform jobs) is not limited. Without app.company_id the policy errors instead of returning rows.
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hrms_app') THEN CREATE ROLE hrms_app NOLOGIN; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN EXECUTE format('GRANT hrms_app TO %I', current_user); END IF; END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO hrms_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hrms_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hrms_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hrms_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO hrms_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "companies" FROM hrms_app;
--> statement-breakpoint
-- sessions: requests may sign a user out (delete), never create or move one
REVOKE INSERT, UPDATE ON "sessions" FROM hrms_app;
--> statement-breakpoint
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "roles" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "users" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "audit_trail" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "audit_trail" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "notifications" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "settings" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "sip_counters" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "sip_counters" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "stored_files" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "stored_files" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "departments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "departments" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "designations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "designations" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "candidates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "candidates" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "applications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "applications" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "stage_history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "stage_history" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "interviews" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "interviews" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "communications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "communications" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "employees" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "employees" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "employee_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "employee_documents" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "salary_structures" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "salary_structures" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "payroll_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "payroll_runs" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "payslips" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "payslips" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "payslip_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "payslip_lines" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "loans_advances" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "loans_advances" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "leave_types" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "leave_types" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "leave_ledger" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "leave_ledger" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "leave_applications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "leave_applications" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
