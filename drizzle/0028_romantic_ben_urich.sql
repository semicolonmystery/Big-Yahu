CREATE TABLE `reembed_job_items` (
	`job_id` integer NOT NULL,
	`fact_id` text NOT NULL,
	`copied` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`job_id`, `fact_id`)
);
--> statement-breakpoint
CREATE TABLE `reembed_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_model` text NOT NULL,
	`source_dimensions` integer NOT NULL,
	`source_collection` text NOT NULL,
	`target_model` text NOT NULL,
	`target_dimensions` integer NOT NULL,
	`target_collection` text NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`copied` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`last_error` text,
	`pauses_recall` integer DEFAULT false NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
