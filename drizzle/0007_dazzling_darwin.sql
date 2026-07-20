CREATE TABLE "lesson" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"kind" text NOT NULL,
	"subject" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "lesson_kind_idx" ON "lesson" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "lesson_created_at_idx" ON "lesson" USING btree ("created_at");