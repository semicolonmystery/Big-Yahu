CREATE TABLE `chat_models` (
	`model` text PRIMARY KEY NOT NULL,
	`weight` integer DEFAULT 100 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`resting_until` integer,
	`last_error` text,
	`created_at` integer NOT NULL
);
