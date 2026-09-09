CREATE TABLE `plugin_storage` (
	`plugin_id` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`plugin_id`, `key`)
);
