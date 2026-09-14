ALTER TABLE `reembed_jobs` ADD `kind` text DEFAULT 'reembed' NOT NULL;--> statement-breakpoint
ALTER TABLE `reembed_jobs` ADD `type_filter` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `reembed_jobs` ADD `bundle_size` integer DEFAULT 0 NOT NULL;