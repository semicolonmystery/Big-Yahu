CREATE TABLE `reputation` (
	`user_id` text PRIMARY KEY NOT NULL,
	`short_term` real NOT NULL,
	`long_term` real NOT NULL,
	`low_streak` integer DEFAULT 0 NOT NULL,
	`judgements` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reputation_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`assessment` text NOT NULL,
	`short_term` real NOT NULL,
	`long_term` real NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL
);
