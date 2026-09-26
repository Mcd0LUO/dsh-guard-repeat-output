// Perturbation and recovery: a lowered effort must last ONE attempt, not the session.
//
// Regression context. The guard lowers reasoning effort on a collapsed retry, and the
// agent loop writes that value into `request/header` (reason "change"), then derives
// every later request from it. Before recovery existed, one collapse left the session
// on the lowered rung permanently: a live session dropped to "low" at seq=4178 and ran
// its remaining 12 steps there.
//
// These checks drive the REAL listeners, so they fail if either the ladder derivation
// or the recovery regresses.
import { RepetitionGuard } from '../index.js'

const results = []
/** Record one boolean assertion, integration.mjs style. */
function check(label, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? '  — ' + detail : ''}`)
}

const SESSION = 'session-perturb-probe'
const DELTA = 400

/** Build a ctx with the seams the guard uses. */
function buildHarness(module, config, { efforts = ['off', 'low', 'high', 'max'] } = {}) {
  const listeners = new Map()
  const inbox = { nextStep: [] }
  const agent = {
    id: SESSION,
    inject: message => inbox.nextStep.push(message),
  }
  const ctx = {
    on: (event, listener) => listeners.set(event, listener),
    get: name => {
      if (name === 'agents') return { get: id => (id === SESSION ? agent : undefined) }
      if (name === 'llm') {
        return {
          async resolveModelInfo(provider, model) {
            return { provider, id: model, reasoning: { efforts: efforts.map(id => ({ id })) } }
          },
        }
      }
      return undefined
    },
  }
  module.apply(ctx, config)
  return { listeners, inbox, agent }
}

/** Stream text through llm/stream on the reasoning channel. */
async function runStream(listeners, text, provider = 'deepseek', model = 'deepseek-chat') {
  const chunks = [{ type: 'block-start', index: 0, blockType: 'reasoning' }]
  for (let i = 0; i < text.length; i += DELTA) {
    chunks.push({ type: 'reasoning-delta', index: 0, text: text.slice(i, i + DELTA) })
  }
  async function* source() { for (const c of chunks) yield c }
  const stream = listeners.get('llm/stream')({ sessionId: SESSION, provider, model }, () => source())
  const yielded = []
  for await (const c of stream) yielded.push(c)
  return yielded
}

/** Drive agent/request exactly as the loop does (waterfall with a seed config). */
async function request(listeners, agent, config) {
  return listeners.get('agent/request')({ agent }, () => Promise.resolve(config))
}

// A text that trips the detector: one short phrase repeated far past the threshold.
const collapse = ('let me write the call. ').repeat(400)

/* ---- 1. Ladder derivation ------------------------------------------------ */

{
  const { listeners, agent } = buildHarness(await import('../index.js'), { truncate: true })
  await runStream(listeners, collapse)

  // The adapter declares [off, low, high, max] — array order is NOT strength order.
  // "Step down" from max must therefore land on high, not on low.
  const out = await request(listeners, agent, {
    provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max',
  })
  check('perturbation steps down by semantic rank, not by adapter array order',
    out.reasoningEffort === 'high', `max -> ${out.reasoningEffort} (want high)`)
}

/* ---- 2. Recovery --------------------------------------------------------- */

{
  const { listeners, agent } = buildHarness(await import('../index.js'), { truncate: true })
  const seed = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' }

  await runStream(listeners, collapse)
  const lowered = await request(listeners, agent, { ...seed })
  const restored = await request(listeners, agent, { ...seed, reasoningEffort: lowered.reasoningEffort })

  check('the perturbation lowers the rung', lowered.reasoningEffort === 'high',
    `got ${lowered.reasoningEffort}`)
  check('the next request restores the original effort', restored.reasoningEffort === 'max',
    `got ${restored.reasoningEffort}`)
}

/* ---- 3. Recovery does not fight an external change ----------------------- */

{
  const { listeners, agent } = buildHarness(await import('../index.js'), { truncate: true })
  const seed = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' }

  await runStream(listeners, collapse)
  const lowered = await request(listeners, agent, { ...seed })
  // Someone else moved the effort while the perturbation was outstanding.
  const external = await request(listeners, agent, {
    ...seed, reasoningEffort: 'off',
  })
  check('an externally chosen effort is not overwritten by recovery',
    external.reasoningEffort === 'off', `got ${external.reasoningEffort}`)
}

/* ---- 4. A model with no reasoning support is left alone ------------------ */

{
  const { listeners, agent } = buildHarness(await import('../index.js'), { truncate: true }, { efforts: [] })
  await runStream(listeners, collapse)
  const out = await request(listeners, agent, {
    provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max',
  })
  check('a model that declares no efforts is not given one',
    out.reasoningEffort === 'max', `got ${out.reasoningEffort}`)
}

/* ---- 5. Repeated collapses still recover to the ORIGINAL rung ------------ */

{
  const { listeners, agent } = buildHarness(await import('../index.js'), {
    truncate: true, maxDegenerationRetries: 5
  })
  const seed = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' }

  await runStream(listeners, collapse)
  const first = await request(listeners, agent, { ...seed })
  await runStream(listeners, collapse)
  const second = await request(listeners, agent, { ...seed, reasoningEffort: first.reasoningEffort })
  const after = await request(listeners, agent, { ...seed, reasoningEffort: second.reasoningEffort })

  check('a second collapse steps down again', second.reasoningEffort === 'low',
    `high -> ${second.reasoningEffort}`)
  check('recovery after two collapses returns to the original rung',
    after.reasoningEffort === 'max', `got ${after.reasoningEffort}`)
}

console.log(results.join('\n'))
const failed = results.filter(r => r.startsWith('FAIL')).length
console.log('\n' + (failed === 0
  ? `PASS — all ${results.length} perturbation checks`
  : `FAIL — ${failed} check(s)`))
process.exit(failed === 0 ? 0 : 1)