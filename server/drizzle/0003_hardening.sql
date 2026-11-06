-- One CNIC per company (NULLs never collide).
CREATE UNIQUE INDEX "employees_cnic_uq" ON "employees" USING btree ("company_id","cnic");
--> statement-breakpoint

-- Requests (role hrms_app) never need the platform tables, except to sign a user
-- out: they may find and delete a user's sessions, and nothing else. Token
-- hashes, expiry and other companies' names stay out of reach.
REVOKE ALL ON "sessions" FROM hrms_app;
--> statement-breakpoint
GRANT SELECT ("id", "user_id"), DELETE ON "sessions" TO hrms_app;
--> statement-breakpoint
REVOKE ALL ON "companies" FROM hrms_app;
