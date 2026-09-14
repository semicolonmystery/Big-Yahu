-- Every built-in task starts with DeepSeek V4.1 Flash, pinned to DeepSeek's own
-- host: the only one serving it at DeepSeek's off-peak prices and $0.003 cache reads.
-- Seeded once, here, rather than at boot, so a list an operator empties stays empty.
INSERT OR IGNORE INTO `task_models` (`task`, `model`, `upstream`, `weight`, `created_at`) VALUES
  ('reply', 'deepseek/deepseek-v4.1-flash', 'deepseek', 100, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('topicExtraction', 'deepseek/deepseek-v4.1-flash', 'deepseek', 100, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('factExtraction', 'deepseek/deepseek-v4.1-flash', 'deepseek', 100, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('dateRepair', 'deepseek/deepseek-v4.1-flash', 'deepseek', 100, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('plugins', 'deepseek/deepseek-v4.1-flash', 'deepseek', 100, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
