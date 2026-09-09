CREATE TABLE `rolling_memories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text` text NOT NULL,
	`remaining` integer NOT NULL,
	`lifespan` integer NOT NULL,
	`message_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rolling_memory_channels` (
	`memory_id` integer NOT NULL,
	`channel_id` text NOT NULL,
	PRIMARY KEY(`memory_id`, `channel_id`)
);
