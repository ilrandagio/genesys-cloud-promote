ALTER TYPE "public"."job_mode" ADD VALUE 'BACKUP';--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "backup" jsonb;