CREATE TABLE "deadline" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"name" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "deadline_name_uq" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "send_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"contact_id" uuid NOT NULL,
	"sequence_state_id" uuid,
	"sequence_kind" text,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"contact_id" uuid NOT NULL,
	"sequence_kind" text NOT NULL,
	"policy_version" integer NOT NULL,
	"step_index" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text,
	"next_run_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "send_log" ADD CONSTRAINT "send_log_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_log" ADD CONSTRAINT "send_log_sequence_state_id_sequence_state_id_fk" FOREIGN KEY ("sequence_state_id") REFERENCES "public"."sequence_state"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_state" ADD CONSTRAINT "sequence_state_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "send_log_contact_idx" ON "send_log" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "send_log_created_at_idx" ON "send_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "send_log_kind_idx" ON "send_log" USING btree ("sequence_kind");--> statement-breakpoint
CREATE INDEX "sequence_state_due_idx" ON "sequence_state" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "sequence_state_contact_idx" ON "sequence_state" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_state_active_uq" ON "sequence_state" USING btree ("contact_id","sequence_kind") WHERE status = 'active';