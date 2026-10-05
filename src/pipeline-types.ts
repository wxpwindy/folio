export type PipelineStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted' | 'skipped'
export interface PipelineStep {
  name: string
  status: PipelineStatus
  startedAt?: string
  finishedAt?: string
  log: string
}
export interface PipelineRun {
  id: string
  status: PipelineStatus
  startedAt: string
  finishedAt?: string
  digest?: string
  releaseReady: boolean
  steps: PipelineStep[]
}
export interface PipelineState {
  available: boolean
  busy: boolean
  canCancel: boolean
  runs: PipelineRun[]
  activeRelease: string | null
  previousRelease: string | null
}