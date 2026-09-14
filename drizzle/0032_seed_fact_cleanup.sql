-- The cleanup pass is a new task, so it starts with the same model every other
-- one was seeded with. Copied from the fact-extraction list where the operator
-- has one, since the two jobs want the same kind of model, and falling back to
-- the shipped default otherwise. Seeded once, here, so a list an operator
-- empties stays empty.
INSERT OR IGNORE INTO `task_models` (`task`, `model`, `upstream`, `weight`, `created_at`)
SELECT 'factCleanup', `model`, `upstream`, `weight`, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `task_models` WHERE `task` = 'factExtraction';--> statement-breakpoint
INSERT OR IGNORE INTO `task_models` (`task`, `model`, `upstream`, `weight`, `created_at`)
SELECT 'factCleanup', 'deepseek/deepseek-v4.1-flash', 'deepseek', 100, CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM `task_models` WHERE `task` = 'factCleanup');
