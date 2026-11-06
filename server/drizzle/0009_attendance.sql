CREATE TABLE "attendance_days" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL,
	"sip_id" text NOT NULL,
	"day" date NOT NULL,
	"source" text NOT NULL,
	"context" text DEFAULT '' NOT NULL,
	"first_at" timestamp with time zone,
	"last_at" timestamp with time zone,
	"calls" integer DEFAULT 0 NOT NULL,
	"talk_sec" integer DEFAULT 0 NOT NULL,
	"status" text,
	"note" text,
	"accounts" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_employee_fk" FOREIGN KEY ("company_id","sip_id") REFERENCES "public"."employees"("company_id","sip_id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_day_uq" ON "attendance_days" USING btree ("company_id","sip_id","day","source","context");--> statement-breakpoint
CREATE INDEX "attendance_day_idx" ON "attendance_days" USING btree ("company_id","day");--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_status_check" CHECK ("status" IS NULL OR "status" IN ('present', 'late', 'half_day', 'absent', 'leave', 'off'));
--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_manual_check" CHECK (("source" = 'manual') = ("status" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "attendance_days" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "attendance_days" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
