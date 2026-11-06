CREATE TABLE "stored_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"original_size" integer NOT NULL,
	"served_size" integer NOT NULL,
	"stored_size" integer NOT NULL,
	"encoding" text NOT NULL,
	"sha256" text NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
