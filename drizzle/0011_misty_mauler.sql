CREATE TABLE `channel_settings` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`can_reply` integer DEFAULT true NOT NULL,
	`can_extract` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL
);
