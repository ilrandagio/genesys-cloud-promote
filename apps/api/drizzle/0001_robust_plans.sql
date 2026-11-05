ALTER TABLE "environments" ADD COLUMN "require_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "edges" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "plan_summary" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "artifact_encrypted" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "approved_at" timestamp;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "applied_job_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "plan_job_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "applied_resources" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_plan_job_id_unique" ON "jobs" USING btree ("plan_job_id");