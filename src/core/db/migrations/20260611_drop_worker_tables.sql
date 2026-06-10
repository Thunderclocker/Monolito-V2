-- Drop worker_jobs table and indexes.
-- Tracked in-flight sub-agent (worker) jobs for daemon-restart recovery.
-- Sub-agent delegation is being removed from the runtime; this table is
-- no longer populated by any code path.
--
-- Idempotent: safe to re-run.

DROP INDEX IF EXISTS idx_worker_jobs_status;
DROP INDEX IF EXISTS idx_worker_jobs_session;
DROP TABLE IF EXISTS worker_jobs;

-- Drop background_tasks table and indexes.
-- Tracked lifecycle of a single background worker invocation
-- (PENDING -> IN_PROGRESS -> HANDOFF/DONE/FAILED). Without the worker
-- feature, no rows are ever created.

DROP INDEX IF EXISTS idx_bg_tasks_session;
DROP INDEX IF EXISTS idx_bg_tasks_status;
DROP INDEX IF EXISTS idx_bg_tasks_agent;
DROP TABLE IF EXISTS background_tasks;

-- Drop background_task_groups table and indexes.
-- Implemented the fan-in barrier (multiple workers -> wake coordinator
-- when the last one finishes). The barrier machinery is removed with
-- the sub-agent feature.

DROP INDEX IF EXISTS idx_bg_groups_session;
DROP TABLE IF EXISTS background_task_groups;
