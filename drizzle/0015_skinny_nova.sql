CREATE TABLE `reply_attempts` (
	`message_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reply_attempts_user_time` ON `reply_attempts` (`user_id`,`created_at`);