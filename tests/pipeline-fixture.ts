import { randomUUID } from 'node:crypto'
import { AppError } from '../server/ai.ts'
import type { PipelineService } from '../server/pipeline.ts'
import type { PipelineRun, PipelineState } from '../src/pipeline-types.ts'

/** In-memory browser fixture only: never launches commands or touches releases. */
export class FakePipeline implements PipelineService {
  private state: PipelineState = this.empty()
  private empty(): PipelineState { return { available: true, busy: false, canCancel: false, runs: [], activeRelease: null, previousRelease: null } }
  reset() { this.state = this.empty() }
  snapshot() { return structuredClone(this.state) }
  start() {
    if (this.state.busy) throw new AppError(409, 'A local pipeline is already running.')
    const run: PipelineRun = { id: randomUUID(), startedAt: new Date().toISOString(), status: 'running', digest: 'a'.repeat(64), releaseReady: false,
      steps: [{ name: 'Lint', status: 'running', log: 'Fictional lint output.\n' }, { name: 'Backend tests', status: 'queued', log: '' }, { name: 'Web build', status: 'queued', log: '' }] }
    this.state.runs.unshift(run); this.state.busy = true; this.state.canCancel = true
    return structuredClone(run)
  }
  complete(fail = false) {
    const run = this.state.runs[0]
    if (!run || run.status !== 'running') throw new AppError(409, 'No fixture run is active.')
    run.status = fail ? 'failed' : 'passed'; run.releaseReady = !fail; run.finishedAt = new Date().toISOString()
    run.steps.forEach((step, i) => { step.status = fail ? (i === 0 ? 'failed' : 'skipped') : 'passed'; step.log = i === 0 && fail ? 'Fictional lint failure.\n' : 'Fictional check completed.\n' })
    this.state.busy = false; this.state.canCancel = false
  }
  cancel(id: string) {
    const run = this.state.runs.find(run => run.id === id)
    if (!run || run.status !== 'running') throw new AppError(409, 'This run is no longer running.')
    run.status = 'cancelled'; run.steps[0].status = 'cancelled'; run.steps.slice(1).forEach(step => { step.status = 'skipped' })
    this.state.busy = false; this.state.canCancel = false
  }
  deploy(id: string) {
    if (this.state.busy || !this.state.runs.some(run => run.id === id && run.releaseReady)) throw new AppError(409, 'Only a successful release can be deployed.')
    this.state.previousRelease = this.state.activeRelease; this.state.activeRelease = id
  }
  rollback() {
    if (this.state.busy || !this.state.previousRelease) throw new AppError(409, 'No previous release is available.')
    const previous = this.state.previousRelease; this.state.previousRelease = this.state.activeRelease; this.state.activeRelease = previous
  }
}