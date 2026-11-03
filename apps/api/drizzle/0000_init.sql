CREATE TYPE "public"."job_mode" AS ENUM('PLAN', 'APPLY');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"region" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_encrypted" text NOT NULL,
	"allow_as_target" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "environments_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mode" "job_mode" NOT NULL,
	"status" "job_status" DEFAULT 'QUEUED' NOT NULL,
	"source_env_id" uuid NOT NULL,
	"target_env_id" uuid NOT NULL,
	"items" jsonb NOT NULL,
	"log" text DEFAULT '' NOT NULL,
	"plan_output" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_source_env_id_environments_id_fk" FOREIGN KEY ("source_env_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_target_env_id_environments_id_fk" FOREIGN KEY ("target_env_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;