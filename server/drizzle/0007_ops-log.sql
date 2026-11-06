CREATE TABLE "ops_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"t" timestamp with time zone DEFAULT now() NOT NULL,
	"lvl" text NOT NULL,
	"msg" text NOT NULL,
	"ctx" jsonb
);
--> statement-breakpoint
CREATE INDEX "ops_log_t_idx" ON "ops_log" USING btree ("t");--> statement-breakpoint
CREATE INDEX "ops_log_lvl_t_idx" ON "ops_log" USING btree ("lvl","t");--> statement-breakpoint
REVOKE ALL ON "ops_log" FROM hrms_app;
--> statement-breakpoint
REVOKE ALL ON SEQUENCE "ops_log_id_seq" FROM hrms_app;
