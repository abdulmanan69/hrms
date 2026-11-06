CREATE TABLE "api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL,
	"type" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"module" text NOT NULL,
	"data" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL,
	"webhook_id" integer NOT NULL,
	"event_id" integer,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"response_status" integer,
	"error" text,
	"duration_ms" integer,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer DEFAULT current_setting('app.company_id')::int NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhooks_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_fk" FOREIGN KEY ("company_id","webhook_id") REFERENCES "public"."webhooks"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_company_idx" ON "api_keys" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "events_company_id_idx" ON "events" USING btree ("company_id","id");--> statement-breakpoint
CREATE INDEX "events_id_idx" ON "events" USING btree ("id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_hook_idx" ON "webhook_deliveries" USING btree ("company_id","webhook_id","id");
--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "api_keys" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "events" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "webhooks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "webhooks" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "company_isolation" ON "webhook_deliveries" USING (company_id = current_setting('app.company_id')::int) WITH CHECK (company_id = current_setting('app.company_id')::int);
-- requests never read secrets back: the key hash is only checked at sign-in and the webhook secret only by the sender (both as owner)
--> statement-breakpoint
REVOKE SELECT ON "api_keys" FROM hrms_app;
--> statement-breakpoint
GRANT SELECT ("id", "company_id", "name", "prefix", "scopes", "created_by", "expires_at", "last_used_at", "revoked_at", "created_at") ON "api_keys" TO hrms_app;
--> statement-breakpoint
REVOKE SELECT ON "webhooks" FROM hrms_app;
--> statement-breakpoint
GRANT SELECT ("id", "company_id", "name", "url", "events", "active", "created_by", "created_at") ON "webhooks" TO hrms_app;
