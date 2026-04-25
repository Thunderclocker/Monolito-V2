CREATE TABLE IF NOT EXISTS worker_jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  profile_id TEXT,
  tool_name TEXT NOT NULL,
  tool_args TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_text TEXT,
  error_text TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_worker_jobs_status
  ON worker_jobs(status);

CREATE INDEX IF NOT EXISTS idx_worker_jobs_session
  ON worker_jobs(session_id);
