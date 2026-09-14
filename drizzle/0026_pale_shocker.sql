DROP TABLE `chat_models`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`check_interval_minutes` integer NOT NULL,
	`reply_context_messages` integer NOT NULL,
	`fact_search_top_k` integer NOT NULL,
	`escalation_lookback_hours` integer NOT NULL,
	`max_escalation_depth` integer NOT NULL,
	`reply_language` text DEFAULT 'en' NOT NULL,
	`rate_limit_per_hour` integer DEFAULT 40 NOT NULL,
	`rate_limit_message` text DEFAULT 'You''ve hit me up a lot this hour — give me a bit and try again.' NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`retry_attempts` integer DEFAULT 2 NOT NULL,
	`retry_delay_ms` integer DEFAULT 3000 NOT NULL,
	`duplicate_distance` integer DEFAULT 25 NOT NULL,
	`embedding_model` text DEFAULT 'openai/text-embedding-3-large' NOT NULL,
	`embedding_dimensions` integer DEFAULT 1536 NOT NULL,
	`active_embedding_model` text DEFAULT '' NOT NULL,
	`active_embedding_dimensions` integer DEFAULT 0 NOT NULL,
	`model_failure_threshold` integer DEFAULT 3 NOT NULL,
	`model_rest_minutes` integer DEFAULT 120 NOT NULL,
	`vision_enabled` integer DEFAULT true NOT NULL,
	`max_images` integer DEFAULT 4 NOT NULL,
	`text_attachment_max_kb` integer DEFAULT 16 NOT NULL,
	`cross_channel_messages` integer DEFAULT 30 NOT NULL,
	`overload_message` text DEFAULT 'every model I can reach is busy right now, try again in a minute' NOT NULL,
	`busy_message` text DEFAULT 'took me too long to work that one out, ask me again' NOT NULL,
	`error_message` text DEFAULT 'something broke on my end, thats not your fault' NOT NULL,
	`no_credits_message` text DEFAULT 'im out of credit, someone whos meant to be paying for me isnt' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_settings`("id", "check_interval_minutes", "reply_context_messages", "fact_search_top_k", "escalation_lookback_hours", "max_escalation_depth", "reply_language", "rate_limit_per_hour", "rate_limit_message", "timezone", "retry_attempts", "retry_delay_ms", "duplicate_distance", "embedding_model", "embedding_dimensions", "active_embedding_model", "active_embedding_dimensions", "model_failure_threshold", "model_rest_minutes", "vision_enabled", "max_images", "text_attachment_max_kb", "cross_channel_messages", "overload_message", "busy_message", "error_message", "no_credits_message", "updated_at") SELECT "id", "check_interval_minutes", "reply_context_messages", "fact_search_top_k", "escalation_lookback_hours", "max_escalation_depth", "reply_language", "rate_limit_per_hour", "rate_limit_message", "timezone", "retry_attempts", "retry_delay_ms", "duplicate_distance", "embedding_model", "embedding_dimensions", "active_embedding_model", "active_embedding_dimensions", "model_failure_threshold", "model_rest_minutes", "vision_enabled", "max_images", "text_attachment_max_kb", "cross_channel_messages", "overload_message", "busy_message", "error_message", "no_credits_message", "updated_at" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
-- The shipped wording named Gemini. An operator who never changed it would
-- otherwise keep telling the channel about a provider the bot no longer uses.
UPDATE `settings` SET `overload_message` = 'every model I can reach is busy right now, try again in a minute'
WHERE `overload_message` = 'Gemini''s getting hammered right now and won''t talk to me. Try again in a minute.';
