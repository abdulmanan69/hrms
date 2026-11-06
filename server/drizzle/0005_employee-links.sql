CREATE TABLE "employee_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL,
	"sip_id" text NOT NULL,
	"system" text NOT NULL,
	"external_id" text NOT NULL,
	"context" text DEFAULT '' NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL,
	"sip_id" text NOT NULL,
	"source" text NOT NULL,
	"metric" text NOT NULL,
	"period" text NOT NULL,
	"value" double precision NOT NULL,
	"unit" text,
	"details" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employee_links" ADD CONSTRAINT "employee_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_links" ADD CONSTRAINT "employee_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_links" ADD CONSTRAINT "employee_links_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_metrics" ADD CONSTRAINT "employee_metrics_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_metrics" ADD CONSTRAINT "employee_metrics_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_links_external_uq" ON "employee_links" USING btree ("company_id","system","context","external_id");--> statement-breakpoint
CREATE INDEX "employee_links_sip_idx" ON "employee_links" USING btree ("company_id","sip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_metrics_uq" ON "employee_metrics" USING btree ("company_id","sip_id","source","metric","period");
--> statement-breakpoint
ALTER TABLE "employee_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "employee_links" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "employee_metrics" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "employee_metrics" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
