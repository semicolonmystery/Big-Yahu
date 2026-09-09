ALTER TABLE `settings` ADD `model_failure_threshold` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `model_rest_minutes` integer DEFAULT 120 NOT NULL;