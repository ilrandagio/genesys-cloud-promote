ALTER TABLE "jobs" ADD COLUMN "plan_files_encrypted" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "rollback_of_job_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "rollback_encrypted" text;