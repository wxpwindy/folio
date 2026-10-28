import { resolve } from 'node:path'
import { LocalPipeline } from './pipeline.ts'

const args = process.argv.slice(2)
if (args.some(argument => argument !== '--deploy')) throw new Error('Usage: npm run ci:local -- [--deploy]')
const deploy = args.includes('--deploy')
const pipeline = new LocalPipeline({ root: resolve('.') })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void pipeline.close() })
try {
  const run = pipeline.start()
  console.log(`Local pipeline started: ${run.id}. Status and logs: Folio → Administration → CI/CD pipeline.`)
  await pipeline.waitForIdle()
  const result = pipeline.snapshot().runs.find(item => item.id === run.id)!
  for (const step of result.steps) console.log(`${step.status}: ${step.name}`)
  if (deploy && result.status === 'passed') {
    pipeline.deploy(run.id)
    console.log(`Pipeline passed. Deployed web release ${run.id}.`)
  } else {
    console.log(`Pipeline ${result.status}. ${deploy ? 'No release deployed.' : 'Deployment requires administrator confirmation in the dashboard.'}`)
  }
  process.exitCode = result.status === 'passed' ? 0 : 1
} finally { await pipeline.close() }