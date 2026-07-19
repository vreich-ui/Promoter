CREATE TABLE "campaign" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"opportunity_id" uuid,
	"brief" jsonb NOT NULL,
	"channel_plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget_cap_usd" numeric,
	"autonomy_mode" text DEFAULT 'flag' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signal_ids" uuid[] NOT NULL,
	"offer_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score" numeric,
	"score_breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'new' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outcome" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"placement_id" uuid NOT NULL,
	"metrics" jsonb NOT NULL,
	"revenue_usd" numeric,
	"cost_usd" numeric,
	"attribution" text
);
--> statement-breakpoint
CREATE TABLE "placement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"campaign_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"tracking" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cms_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"body" jsonb NOT NULL,
	CONSTRAINT "policy_version_kind_version_uq" UNIQUE("kind","version")
);
--> statement-breakpoint
CREATE TABLE "signal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw" jsonb NOT NULL,
	"topic" text,
	"velocity" numeric,
	"observed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_opportunity_id_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome" ADD CONSTRAINT "outcome_placement_id_placement_id_fk" FOREIGN KEY ("placement_id") REFERENCES "public"."placement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_campaign_id_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaign"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opportunity_status_idx" ON "opportunity" USING btree ("status");--> statement-breakpoint
CREATE INDEX "outcome_placement_id_idx" ON "outcome" USING btree ("placement_id");--> statement-breakpoint
CREATE INDEX "placement_campaign_id_idx" ON "placement" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "signal_observed_at_idx" ON "signal" USING btree ("observed_at");