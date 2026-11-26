CREATE TABLE "release_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tag_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"undone_job_id" uuid,
	"type" text,
	"tf_type" text NOT NULL,
	"target_id" text,
	"name" text NOT NULL,
	"subtype" text,
	"content" jsonb,
	"info" jsonb,
	"captured_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"target_env_id" uuid NOT NULL,
	"description" text,
	"promoted_from_tag_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp,
	"closed_by" text
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "release_tag_id" uuid;--> statement-breakpoint
ALTER TABLE "release_objects" ADD CONSTRAINT "release_objects_tag_id_release_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."release_tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_objects" ADD CONSTRAINT "release_objects_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_tags" ADD CONSTRAINT "release_tags_target_env_id_environments_id_fk" FOREIGN KEY ("target_env_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "release_tags_env_name_unique" ON "release_tags" USING btree ("target_env_id","name");