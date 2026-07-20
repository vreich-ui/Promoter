CREATE TABLE "assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"experiment_id" uuid NOT NULL,
	"variant_id" uuid,
	"contact_id" uuid,
	"visitor_token" text,
	"is_holdout" integer DEFAULT 0 NOT NULL,
	"converted" integer DEFAULT 0 NOT NULL,
	"converted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "experiment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"campaign_id" uuid,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"holdout_ratio" numeric DEFAULT '0.1' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_variant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"offer_ref" text NOT NULL,
	"price_frame" text,
	"guarantee" text,
	"bonus_stack" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deadline_name" text
);
--> statement-breakpoint
CREATE TABLE "variant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"experiment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "variant_experiment_name_uq" UNIQUE("experiment_id","name")
);
--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_experiment_id_experiment_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment" ADD CONSTRAINT "experiment_campaign_id_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaign"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant" ADD CONSTRAINT "variant_experiment_id_experiment_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignment_experiment_idx" ON "assignment" USING btree ("experiment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_contact_uq" ON "assignment" USING btree ("experiment_id","contact_id") WHERE contact_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_token_uq" ON "assignment" USING btree ("experiment_id","visitor_token") WHERE visitor_token is not null;