ALTER TABLE "applications" DROP CONSTRAINT "applications_hired_fk";
--> statement-breakpoint
ALTER TABLE "employee_documents" DROP CONSTRAINT "employee_documents_employee_fk";
--> statement-breakpoint
ALTER TABLE "employee_links" DROP CONSTRAINT "employee_links_employee_fk";
--> statement-breakpoint
ALTER TABLE "employee_metrics" DROP CONSTRAINT "employee_metrics_employee_fk";
--> statement-breakpoint
ALTER TABLE "employees" DROP CONSTRAINT "employees_manager_fk";
--> statement-breakpoint
ALTER TABLE "leave_applications" DROP CONSTRAINT "leave_apps_employee_fk";
--> statement-breakpoint
ALTER TABLE "leave_ledger" DROP CONSTRAINT "leave_ledger_employee_fk";
--> statement-breakpoint
ALTER TABLE "loans_advances" DROP CONSTRAINT "loans_employee_fk";
--> statement-breakpoint
ALTER TABLE "payslips" DROP CONSTRAINT "payslips_employee_fk";
--> statement-breakpoint
ALTER TABLE "salary_structures" DROP CONSTRAINT "salary_structures_employee_fk";
--> statement-breakpoint
ALTER TABLE "sales" DROP CONSTRAINT "sales_employee_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_employee_fk";
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_hired_fk" FOREIGN KEY ("company_id","hired_sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "employee_links" ADD CONSTRAINT "employee_links_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "employee_metrics" ADD CONSTRAINT "employee_metrics_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_manager_fk" FOREIGN KEY ("company_id","manager_sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "leave_applications" ADD CONSTRAINT "leave_apps_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "leave_ledger" ADD CONSTRAINT "leave_ledger_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "loans_advances" ADD CONSTRAINT "loans_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE cascade;