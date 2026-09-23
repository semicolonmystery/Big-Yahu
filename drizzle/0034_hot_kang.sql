ALTER TABLE `settings` ADD `image_limit_disabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `reply_split_delay_ms` integer DEFAULT 400 NOT NULL;