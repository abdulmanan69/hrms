CREATE TABLE "sales" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL,
	"sip_id" text NOT NULL,
	"role" text NOT NULL,
	"sale_date" date NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"context" text DEFAULT '' NOT NULL,
	"external_ref" text,
	"external_user" text,
	"reference" text,
	"amount" integer,
	"note" text,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"void_reason" text,
	"voided_by" integer,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_external_uq" ON "sales" USING btree ("company_id","source","context","external_ref","role");--> statement-breakpoint
CREATE INDEX "sales_date_idx" ON "sales" USING btree ("company_id","sale_date");--> statement-breakpoint
CREATE INDEX "sales_sip_date_idx" ON "sales" USING btree ("company_id","sip_id","sale_date");--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_role_check" CHECK ("role" IN ('closer', 'fronter'));
--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_status_check" CHECK ("status" IN ('confirmed', 'void'));
--> statement-breakpoint
ALTER TABLE "sales" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "sales" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
