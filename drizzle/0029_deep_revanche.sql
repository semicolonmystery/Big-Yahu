CREATE TABLE `fact_index` (
	`fact_id` text PRIMARY KEY NOT NULL,
	`guild_id` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`types` text DEFAULT ' ' NOT NULL,
	`people` text DEFAULT ' ' NOT NULL,
	`messages` text DEFAULT ' ' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `fact_index_created_at` ON `fact_index` (`created_at`);--> statement-breakpoint
CREATE INDEX `fact_index_types` ON `fact_index` (`types`);--> statement-breakpoint
CREATE TABLE `fact_types` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`description` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`built_in` integer DEFAULT false NOT NULL,
	`duplicate_distance` integer NOT NULL,
	`fact_search_top_k` integer NOT NULL,
	`fact_search_max_distance` integer NOT NULL,
	`updated_at` integer NOT NULL
);
