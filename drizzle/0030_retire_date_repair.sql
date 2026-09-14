-- The date-repair call is gone: both fact-writing prompts now resolve relative
-- dates as they write, so nothing sends anything to this task. Its rows are
-- removed rather than left behind, or Settings shows a model list for a job
-- nothing calls.
DELETE FROM `task_models` WHERE `task` = 'dateRepair';--> statement-breakpoint
DELETE FROM `ai_tasks` WHERE `task` = 'dateRepair';
