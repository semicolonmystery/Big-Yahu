CREATE TABLE `message_bundles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` text NOT NULL,
	`message_ids` text NOT NULL,
	`first_message_id` text NOT NULL,
	`sealed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `message_bundles_channel` ON `message_bundles` (`channel_id`,`first_message_id`);--> statement-breakpoint
ALTER TABLE `settings` ADD `message_bundling_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `message_bundle_size` integer DEFAULT 5 NOT NULL;