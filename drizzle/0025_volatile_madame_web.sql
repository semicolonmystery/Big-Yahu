ALTER TABLE `settings` ADD `embedding_model` text DEFAULT 'openai/text-embedding-3-large' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `embedding_dimensions` integer DEFAULT 1536 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `active_embedding_model` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `active_embedding_dimensions` integer DEFAULT 0 NOT NULL;