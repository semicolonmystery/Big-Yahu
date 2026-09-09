ALTER TABLE `settings` ADD `chat_model` text DEFAULT 'gemini-3.1-flash-lite' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `retry_attempts` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `retry_delay_ms` integer DEFAULT 3000 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `overload_message` text DEFAULT 'Gemini''s getting hammered right now and won''t talk to me. Try again in a minute.' NOT NULL;