CREATE TABLE `plugin_env` (
	`plugin_id` text NOT NULL,
	`key` text NOT NULL,
	`value_encrypted` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`plugin_id`, `key`)
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `elevated_until` integer;