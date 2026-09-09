PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_channel_settings` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`can_reply` integer DEFAULT true NOT NULL,
	`can_extract` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_channel_settings`("channel_id", "guild_id", "can_reply", "can_extract", "updated_at") SELECT "channel_id", "guild_id", "can_reply", "can_extract", "updated_at" FROM `channel_settings`;--> statement-breakpoint
DROP TABLE `channel_settings`;--> statement-breakpoint
ALTER TABLE `__new_channel_settings` RENAME TO `channel_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;