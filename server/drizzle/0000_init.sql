CREATE TABLE "applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"candidate_id" integer NOT NULL,
	"position_applied" text NOT NULL,
	"department_id" integer,
	"application_date" date NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"current_stage" text DEFAULT 'application_received' NOT NULL,
	"priority_rank" integer,
	"owner_recruiter_id" integer,
	"next_followup_date" date,
	"hired_sip_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_trail" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"summary" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" serial PRIMARY KEY NOT NULL,
	"first_name" text NOT NULL,
	"middle_initial" text,
	"last_name" text NOT NULL,
	"email" text,
	"phone" text,
	"alt_phone" text,
	"address1" text,
	"address2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country" text,
	"gender" text,
	"date_of_birth" date,
	"cnic" text,
	"source" text,
	"notes" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "communications" (
	"id" serial PRIMARY KEY NOT NULL,
	"candidate_id" integer NOT NULL,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"subject" text,
	"summary" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"next_followup_date" date,
	"user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "designations" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"department_id" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"sip_id" text NOT NULL,
	"type" text NOT NULL,
	"file_name" text NOT NULL,
	"stored_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" integer,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"sip_id" text PRIMARY KEY NOT NULL,
	"source_candidate_id" integer,
	"first_name" text NOT NULL,
	"middle_initial" text,
	"last_name" text NOT NULL,
	"cnic" text,
	"email" text,
	"phone" text,
	"alt_phone" text,
	"address1" text,
	"address2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country" text,
	"gender" text,
	"date_of_birth" date,
	"department_id" integer,
	"designation_id" integer,
	"manager_sip_id" text,
	"employment_status" text DEFAULT 'probation' NOT NULL,
	"date_of_joining" date NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"bank_name" text,
	"account_no" text,
	"remarks" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_id" integer NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"interviewer_ids" integer[] DEFAULT '{}'::int[] NOT NULL,
	"mode" text NOT NULL,
	"outcome" text,
	"rating" integer,
	"feedback_notes" text,
	"followup_action" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"sip_id" text NOT NULL,
	"leave_type_id" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"total_days" double precision NOT NULL,
	"unpaid_days" double precision DEFAULT 0 NOT NULL,
	"half_day" boolean DEFAULT false NOT NULL,
	"reason" text,
	"attachment_name" text,
	"attachment_stored" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"approver_id" integer,
	"decision_comment" text,
	"decided_at" timestamp with time zone,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"sip_id" text NOT NULL,
	"leave_type_id" integer NOT NULL,
	"entry_type" text NOT NULL,
	"days" double precision NOT NULL,
	"entry_date" date NOT NULL,
	"reference" text,
	"note" text,
	"balance_after" double precision NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"annual_entitlement_days" double precision DEFAULT 0 NOT NULL,
	"is_paid" boolean DEFAULT true NOT NULL,
	"accrual_rule" text DEFAULT 'annual' NOT NULL,
	"carry_forward_max" double precision DEFAULT 0 NOT NULL,
	"requires_attachment" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leave_types_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "loans_advances" (
	"id" serial PRIMARY KEY NOT NULL,
	"sip_id" text NOT NULL,
	"entry_type" text NOT NULL,
	"amount" integer NOT NULL,
	"installment" integer,
	"entry_date" date NOT NULL,
	"run_id" integer,
	"note" text,
	"balance_after" integer NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"period_month" text NOT NULL,
	"days_of_month" integer NOT NULL,
	"working_days" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"created_by" integer,
	"approved_by" integer,
	"approved_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_period_month_unique" UNIQUE("period_month")
);
--> statement-breakpoint
CREATE TABLE "payslip_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"payslip_id" integer NOT NULL,
	"section" text NOT NULL,
	"component" text NOT NULL,
	"amount" integer NOT NULL,
	"is_manual" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payslips" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"sip_id" text NOT NULL,
	"current_salary_days" double precision DEFAULT 0 NOT NULL,
	"new_salary_days" double precision DEFAULT 0 NOT NULL,
	"not_joined_days" double precision DEFAULT 0 NOT NULL,
	"unpaid_days" double precision DEFAULT 0 NOT NULL,
	"gross_a" integer DEFAULT 0 NOT NULL,
	"total_additions_b" integer DEFAULT 0 NOT NULL,
	"total_deductions_c" integer DEFAULT 0 NOT NULL,
	"net_total" integer DEFAULT 0 NOT NULL,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "salary_structures" (
	"id" serial PRIMARY KEY NOT NULL,
	"sip_id" text NOT NULL,
	"effective_from" date NOT NULL,
	"basic_salary" integer NOT NULL,
	"house_rent" integer DEFAULT 0 NOT NULL,
	"medical_allowance" integer DEFAULT 0 NOT NULL,
	"petrol_allowance" integer DEFAULT 0 NOT NULL,
	"other_allowance" integer DEFAULT 0 NOT NULL,
	"gross_salary" integer NOT NULL,
	"pf_applicable" boolean DEFAULT true NOT NULL,
	"eobi_applicable" boolean DEFAULT true NOT NULL,
	"wht_applicable" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sip_counters" (
	"year" integer PRIMARY KEY NOT NULL,
	"last" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_id" integer NOT NULL,
	"from_stage" text,
	"to_stage" text NOT NULL,
	"note" text,
	"user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role_id" integer NOT NULL,
	"sip_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_owner_recruiter_id_users_id_fk" FOREIGN KEY ("owner_recruiter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_hired_sip_id_employees_sip_id_fk" FOREIGN KEY ("hired_sip_id") REFERENCES "public"."employees"("sip_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_trail" ADD CONSTRAINT "audit_trail_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designations" ADD CONSTRAINT "designations_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_sip_id_employees_sip_id_fk" FOREIGN KEY ("sip_id") REFERENCES "public"."employees"("sip_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_source_candidate_id_candidates_id_fk" FOREIGN KEY ("source_candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_designation_id_designations_id_fk" FOREIGN KEY ("designation_id") REFERENCES "public"."designations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_manager_sip_id_employees_sip_id_fk" FOREIGN KEY ("manager_sip_id") REFERENCES "public"."employees"("sip_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_applications" ADD CONSTRAINT "leave_applications_sip_id_employees_sip_id_fk" FOREIGN KEY ("sip_id") REFERENCES "public"."employees"("sip_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_applications" ADD CONSTRAINT "leave_applications_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_applications" ADD CONSTRAINT "leave_applications_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_applications" ADD CONSTRAINT "leave_applications_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_ledger" ADD CONSTRAINT "leave_ledger_sip_id_employees_sip_id_fk" FOREIGN KEY ("sip_id") REFERENCES "public"."employees"("sip_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_ledger" ADD CONSTRAINT "leave_ledger_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_ledger" ADD CONSTRAINT "leave_ledger_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans_advances" ADD CONSTRAINT "loans_advances_sip_id_employees_sip_id_fk" FOREIGN KEY ("sip_id") REFERENCES "public"."employees"("sip_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans_advances" ADD CONSTRAINT "loans_advances_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans_advances" ADD CONSTRAINT "loans_advances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_payslip_id_payslips_id_fk" FOREIGN KEY ("payslip_id") REFERENCES "public"."payslips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_sip_id_employees_sip_id_fk" FOREIGN KEY ("sip_id") REFERENCES "public"."employees"("sip_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_sip_id_employees_sip_id_fk" FOREIGN KEY ("sip_id") REFERENCES "public"."employees"("sip_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_sip_id_employees_sip_id_fk" FOREIGN KEY ("sip_id") REFERENCES "public"."employees"("sip_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applications_stage_idx" ON "applications" USING btree ("current_stage");--> statement-breakpoint
CREATE INDEX "applications_candidate_idx" ON "applications" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "applications_followup_idx" ON "applications" USING btree ("next_followup_date");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_trail" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_trail" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "candidates_name_idx" ON "candidates" USING btree ("last_name","first_name");--> statement-breakpoint
CREATE INDEX "communications_candidate_idx" ON "communications" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "employee_documents_sip_idx" ON "employee_documents" USING btree ("sip_id");--> statement-breakpoint
CREATE INDEX "employees_dept_idx" ON "employees" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "employees_status_idx" ON "employees" USING btree ("status");--> statement-breakpoint
CREATE INDEX "employees_manager_idx" ON "employees" USING btree ("manager_sip_id");--> statement-breakpoint
CREATE INDEX "employees_name_idx" ON "employees" USING btree ("last_name","first_name");--> statement-breakpoint
CREATE INDEX "interviews_app_idx" ON "interviews" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "interviews_when_idx" ON "interviews" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "leave_apps_sip_idx" ON "leave_applications" USING btree ("sip_id");--> statement-breakpoint
CREATE INDEX "leave_apps_status_idx" ON "leave_applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "leave_apps_dates_idx" ON "leave_applications" USING btree ("start_date","end_date");--> statement-breakpoint
CREATE INDEX "leave_ledger_sip_type_idx" ON "leave_ledger" USING btree ("sip_id","leave_type_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_ledger_reference_uq" ON "leave_ledger" USING btree ("sip_id","leave_type_id","reference");--> statement-breakpoint
CREATE INDEX "loans_sip_idx" ON "loans_advances" USING btree ("sip_id","id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "payslip_lines_payslip_idx" ON "payslip_lines" USING btree ("payslip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payslips_run_sip_uq" ON "payslips" USING btree ("run_id","sip_id");--> statement-breakpoint
CREATE INDEX "payslips_sip_idx" ON "payslips" USING btree ("sip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "salary_structures_period_uq" ON "salary_structures" USING btree ("sip_id","effective_from");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "stage_history_app_idx" ON "stage_history" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_sip_id_uq" ON "users" USING btree ("sip_id");