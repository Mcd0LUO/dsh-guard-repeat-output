// Perturbation and recovery: a lowered effort lasts ONE TURN, not the session.
//
// Regression context, both halves from real traffic:
//
//  1. The loop writes a perturbed effort into `request/header` (reason "change") and
//     derives every later request from it. Before recovery existed, one collapse left
//     the session on the lowered rung permanently — a live session dropped to "low"
//     and ran its remaining 12 steps there.
//  2. The ladder was hard-coded. The observed adapter declares off/low/high/max and
//     NOT medium, so stepping "high" down to "medium" threw
//     UNSUPPORTED_REASONING_EFFORT and killed the turn. That is exactly how 8 real
//     turns died ("does not support reasoning effort \"medium\"").
//
// These checks drive the REAL listeners, so they fail if either half regresses.
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

/** Enter a step, as the loop does before every request. This is what advances the turn. */
async function preStep(listeners, agent, turn) {
  const listener = listeners.get('agent/pre-step')
  const payload = { agent, messages: [], turn, step: 1, signal: new AbortController().signal }
  const fallback = () => Promise.resolve({ kind: 'enter', messages: [] })
  return listener === undefined ? fallback() : listener(payload, fallback)
}

/** Drive agent/request exactly as the loop does (waterfall with a seed config). */
async function request(listeners, agent, config) {
  return listeners.get('agent/request')({ agent }, () => Promise.resolve(config))
}

// A text that trips the detector: one short phrase repeated far past the threshold.
const collapse = ('let me write the call. ').repeat(400)

/* ---- 1. Ladder derivation: adapter order is not strength order ----------- */

{
  const { listeners, agent } = buildHarness(await import('../index.js'), { truncate: true })
  await preStep(listeners, agent, 1)
  await runStream(listeners, collapse)

  // The adapter declares [off, low, high, max]. "Step down" from max must land on
  // high; taking the array's next entry would have landed on nothing sensible, and
  // the old hard-coded ladder would have proposed "medium" (which does not exist).
  const out = await request(listeners, agent, {
    provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max',
  })
  check('perturbation steps down by semantic rank, not by adapter array order',
    out.reasoningEffort === 'high', `max -> ${out.reasoningEffort} (want high)`)
}

/* ---- 2. The lowered rung holds for the rest of the collapsing turn ------- */

{
  const { listeners, agent } = buildHarness(await import('../index.js'), { truncate: true })
  const seed = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' }

  await preStep(listeners, agent, 1)
  await runStream(listeners, collapse)
  const lowered = await request(listeners, agent, { ...seed })
  // Another request inside the SAME turn must not bounce back to the rung that
  // just collapsed.
  const sameTurn = await request(listeners, agent, {
    ...seed, reasoningEffort: lowered.reasoningEffort,
  })

  check('the perturbation lowers the rung', lowered.reasoningEffort === 'high',
    `got ${lowered.reasoningEffort}`)
  check('a later request in the same turn stays on the lowered rung',
    sameTurn.reasoningEffort === 'high', `got ${sameTurn.reasoningEffort}`)
}

/* ---- 3. The next turn restores the original rung ------------------------- */

{
  const { listeners, agent } = buildHarness(await import('../index.js'), { truncate: true })
  const seed = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' }

  await preStep(listeners, agent, 1)
  await runStream(listeners, collapse)
  const lowered = await request(listeners, agent, { ...seed })
  // The turn ends; the next turn begins.
  await preStep(listeners, agent, 2)
  const restored = await request(listeners, agent, {
    ...seed, reasoningEffort: lowered.reasoningEffort,
  })

  check('the next turn restores the original effort', restored.reasoningEffort === 'max',
    `got ${restored.reasoningEffort}`)
}

/* ---- 4. Recovery does not fight an external change ----------------------- */

{
  const { listeners, agent } = buildHarness(await import('../index.js'), { truncate: true })
  const seed = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' }

  await preStep(listeners, agent, 1)
  await runStream(listeners, collapse)
  await request(listeners, agent, { ...seed })
  await preStep(listeners, agent, 2)
  // Someone else moved the effort while the perturbation was outstanding.
  const external = await request(listeners, agent, { ...seed, reasoningEffort: 'off' })
  check('an externally chosen effort is not overwritten by recovery',
    external.reasoningEffort === 'off', `got ${external.reasoningEffort}`)
}

/* ---- 5. A model that declares no reasoning support is left alone --------- */

{
  const { listeners, agent } = buildHarness(await import('../index.js'), { truncate: true }, { efforts: [] })
  await preStep(listeners, agent, 1)
  await runStream(listeners, collapse)
  const out = await request(listeners, agent, {
    provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max',
  })
  check('a model that declares no efforts is not given one',
    out.reasoningEffort === 'max', `got ${out.reasoningEffort}`)
}

/* ---- 6. Two collapses in one turn still recover to the ORIGINAL rung ----- */

{
  const { listeners, agent } = buildHarness(await import('../index.js'), {
    truncate: true, maxDegenerationRetries: 5,
  })
  const seed = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' }

  await preStep(listeners, agent, 1)
  await runStream(listeners, collapse)
  const first = await request(listeners, agent, { ...seed })
  await runStream(listeners, collapse)
  const second = await request(listeners, agent, { ...seed, reasoningEffort: first.reasoningEffort })

  await preStep(listeners, agent, 2)
  const after = await request(listeners, agent, { ...seed, reasoningEffort: second.reasoningEffort })

  check('a second collapse steps down again', second.reasoningEffort === 'low',
    `high -> ${second.reasoningEffort}`)
  check('recovery after two collapses returns to the original rung',
    after.reasoningEffort === 'max', `got ${after.reasoningEffort}`)
}

/* ---- 7. A one-rung model never gets an unsupported effort ---------------- */

{
  // Only "high" is declared. There is nothing to step down to, and the old
  // hard-coded ladder would have proposed "medium" here — the real dead turn.
  const { listeners, agent } = buildHarness(await import('../index.js'), { truncate: true }, { efforts: ['high'] })
  await preStep(listeners, agent, 1)
  await runStream(listeners, collapse)
  const out = await request(listeners, agent, {
    provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high',
  })
  check('a single-rung model is left on its only rung (no unsupported proposal)',
    out.reasoningEffort === 'high', `got ${out.reasoningEffort}`)
}

console.log(results.join('\n'))
const failed = results.filter(r => r.startsWith('FAIL')).length
console.log('\n' + (failed === 0
  ? `PASS — all ${results.length} perturbation checks`
  : `FAIL — ${failed} check(s)`))
process.exit(failed === 0 ? 0 : 1)
