export type WorkerJobStatus = "pending" | "running" | "completed" | "failed"

export interface WorkerJob {
  id: string
  session_id: string
  profile_id: string | null
  tool_name: string
  tool_args: string
  status: WorkerJobStatus
  result_text: string | null
  error_text: string | null
  created_at: string
  updated_at: string
}
