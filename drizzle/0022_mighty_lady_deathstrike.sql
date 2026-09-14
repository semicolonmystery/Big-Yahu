CREATE TABLE `ai_tasks` (
	`task` text PRIMARY KEY NOT NULL,
	`reasoning_effort` text DEFAULT 'none' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_models` (
	`task` text NOT NULL,
	`model` text NOT NULL,
	`upstream` text DEFAULT '' NOT NULL,
	`weight` integer DEFAULT 100 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`resting_until` integer,
	`retired` integer DEFAULT false NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`task`, `model`)
);
