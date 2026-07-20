CREATE TABLE "consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"granted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "consent_contact_channel_uq" UNIQUE("contact_id","channel")
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"email" text,
	"name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ladder_stage" text DEFAULT 'lead' NOT NULL,
	"rfm" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "contact_email_uq" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"contact_id" uuid,
	"placement_id" uuid,
	"tracking_code" text,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "segment_name_uq" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "segment_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"segment_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	CONSTRAINT "segment_member_uq" UNIQUE("segment_id","contact_id")
);
--> statement-breakpoint
ALTER TABLE "placement" ADD COLUMN "tracking_code" text;--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_placement_id_placement_id_fk" FOREIGN KEY ("placement_id") REFERENCES "public"."placement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_member" ADD CONSTRAINT "segment_member_segment_id_segment_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_member" ADD CONSTRAINT "segment_member_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_contact_id_idx" ON "event" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "event_occurred_at_idx" ON "event" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "event_tracking_code_idx" ON "event" USING btree ("tracking_code");--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_tracking_code_uq" UNIQUE("tracking_code");