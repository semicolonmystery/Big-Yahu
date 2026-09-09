CREATE TABLE `admin_user` (
	`id` integer PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_user_username_unique` ON `admin_user` (`username`);--> statement-breakpoint
CREATE TABLE `cached_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`guild_id` text NOT NULL,
	`author_id` text NOT NULL,
	`author_username` text NOT NULL,
	`content` text NOT NULL,
	`message_created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channel_checkpoints` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`last_message_id` text,
	`last_checked_at` integer
);
--> statement-breakpoint
CREATE TABLE `plugin_state` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`config_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reply_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`tagged_message_id` text NOT NULL,
	`reply_message_id` text,
	`user_id` text NOT NULL,
	`content` text NOT NULL,
	`fact_ids_used` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`check_interval_minutes` integer NOT NULL,
	`reply_context_messages` integer NOT NULL,
	`fact_search_top_k` integer NOT NULL,
	`escalation_lookback_hours` integer NOT NULL,
	`max_escalation_depth` integer NOT NULL,
	`updated_at` integer NOT NULL
);
