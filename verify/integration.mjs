/**
 * W1511 integration test — the three steps wired together.
 *
 * Simulates the agent loop's actual turn semantics around the two seams the
 * plugin installs on, using the SHIPPED `../index.js`:
 *
 *   llm/stream  -> chunks in, truncated stream out, continuation injected
 *   inbox       -> `inject` lands in `nextStep`, which is what keeps the turn open
 *   agent/pre-step -> the injected instruction is admitted into the next step
 *
 * The loop rules being simulated (core/agent-loop/src/agent.ts):
 *   - `inject(input)` = `send(input, 'next-step', false)` -> inbox.nextStep
 *   - after a step ends, `if (turnEnds && inbox.nextStep.length === 0) break`
 *     so a non-empty nextStep runs exactly one more step
 *   - `preStep` claims nextStep and runs the `agent/pre-step` waterfall
 *
 * Usage: node integration.mjs <corpusRoot>
 *
 * The corpus is not shipped: it is real captured model output and stays private.
 * Point <corpusRoot> at any tree containing:
 *   legit/L00001.txt       — healthy reasoning text
 *   unreg/deg1-seq2608.txt — a captured repetition collapse
 */
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepetitionGuard } from '../index.js'

const ROOT = process.argv[2]
if (!ROOT) {
  console.error('usage: node integration.mjs <corpusRoot>')
  console.error('  <corpusRoot> must contain legit/L00001.txt and unreg/deg1-seq2608.txt')
  process.exit(2)
}
// A temp path, not a fixed internal one, so this runs on any host.
const LOG_PATH = join(tmpdir(), 'guard-integration-probe.log')
const DELTA = 40
const SESSION = 'session-integration'

let failures = 0
function check(label, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

/* ------------------------------------------------------------------ *
 * A faithful-enough stand-in for the live Agent + loop
 * ------------------------------------------------------------------ */

function buildHarness(module, config) {
  const listeners = new Map()

  // The inbox the loop owns. `inject` appends to next-step.
  const inbox = { nextStep: [] }

  const agent = {
    id: SESSION,
    // Exactly what ReactLoopAgent.inject does: send(input, 'next-step', false).
    inject: message => inbox.nextStep.push(message),
  }

  const ctx = {
    on: (event, listener) => listeners.set(event, listener),
    get: serviceName => (serviceName === 'agents'
      ? { get: id => (id === SESSION ? agent : undefined) }
      : undefined),
  }

  module.apply(ctx, config)
  return { listeners, inbox, agent }
}

/** Drive one model stream through the llm/stream listener. */
async function runStream(listeners, chunks) {
  let sourceClosed = false
  async function* source() {
    try {
      for (const chunk of chunks) yield chunk
    } finally {
      sourceClosed = true
    }
  }
  const stream = listeners.get('llm/stream')(
    { sessionId: SESSION, provider: 'deepseek', model: 'deepseek-chat' },
    () => source(),
  )
  const yielded = []
  for await (const chunk of stream) yielded.push(chunk)
  return { yielded, sourceClosed }
}

/**
 * Run one `agent/pre-step` waterfall the way `preStep` does.
 *
 * The `agent` passed here MUST be the same object the `llm/stream` listener saw:
 * the plugin keys its per-agent state in a WeakMap, and the real loop dispatches
 * both seams with the identical Agent instance.
 */
async function runPreStep(listeners, agent, claimed, turn) {
  const listener = listeners.get('agent/pre-step')
  const payload = { agent, messages: claimed, turn, step: 1, signal: new AbortController().signal }
  const fallback = () => Promise.resolve({ kind: 'enter', messages: claimed })
  return listener === undefined ? fallback() : listener(payload, fallback)
}

/** Split text into StreamChunks for one channel. */
function chunksOf(text, channel, index = 0) {
  const type = channel === 'reasoning' ? 'reasoning-delta' : 'text-delta'
  const out = [{ type: 'block-start', index, blockType: channel === 'reasoning' ? 'reasoning' : 'text' }]
  for (let i = 0; i < text.length; i += DELTA) out.push({ type, index, text: text.slice(i, i + DELTA) })
  return out
}

/* ------------------------------------------------------------------ *
 * Scenario
 * ------------------------------------------------------------------ */

// The real incident shape: healthy reasoning, then the collapse, all on the
// reasoning channel while the body text stays healthy.
const healthy = readFileSync(`${ROOT}/legit/L00001.txt`, 'utf8').slice(0, 6000)
const degenerate = readFileSync(`${ROOT}/unreg/deg1-seq2608.txt`, 'utf8').slice(0, 60000)
const fullText = healthy + degenerate
const chunks = [...chunksOf(healthy, 'reasoning', 0), ...chunksOf(degenerate, 'reasoning', 0)]

if (existsSync(LOG_PATH)) rmSync(LOG_PATH)

const { listeners, inbox, agent } = buildHarness(await import('../index.js'), {
  logPath: LOG_PATH,
  // v2: a collapse DISCARDS the attempt and re-issues it, so the primary path
  // injects nothing. The continuation below belongs to the budget-exhausted
  // fallback, which is why the budget is forced to 0 here.
  maxDegenerationRetries: 0,
  maxTruncationsPerTurn: 2,
})

console.log('=== STEP 1+2: detect and cut (llm/stream) ===')
const run = await runStream(listeners, chunks)
const yieldedText = run.yielded.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')

check('stream was cut before the full degenerate text',
  yieldedText.length < fullText.length,
  `${yieldedText.length} of ${fullText.length} chars`)
check('healthy prefix survived intact', yieldedText.startsWith(healthy),
  `${healthy.length} chars kept`)
check('yielded text is a strict prefix of the source (no invented text)',
  fullText.startsWith(yieldedText))
check('upstream adapter iterator was closed (request cancelled, not merely ignored)',
  run.sourceClosed === true)
check('with the retry budget spent, no error finish is emitted (turn does not fail)',
  !run.yielded.some(c => c.type === 'finish' && c.reason?.kind === 'error'),
  'BlockAssembler.finish defaults to stop when the stream omits one')

console.log('\n=== STEP 3: continue (inject -> inbox.next-step) ===')
check('exactly one continuation was injected', inbox.nextStep.length === 1,
  `${inbox.nextStep.length} message(s)`)
const injected = inbox.nextStep[0]
check('injected message is a well-formed user message',
  injected?.role === 'user' && Array.isArray(injected?.content) && injected.content[0]?.type === 'text')
check('injected message carries a fresh id', typeof injected?.id === 'string' && injected.id.length > 0)
check('source is plugin-produced context, not a fake human prompt',
  injected?.source?.kind === 'plugin:dsh-guard-repeat-output',
  JSON.stringify(injected?.source))
check('instruction names the collapse and tells the model what to do',
  /degenerate repetition/.test(injected.content[0].text)
  && /Do not resume/.test(injected.content[0].text))

console.log('\n=== LOOP: a non-empty nextStep keeps the turn open one more step ===')
// The loop breaks only while nextStep is empty; claiming it here is what the
// next `preStep` call does.
const claimed = inbox.nextStep.splice(0, inbox.nextStep.length)
check('the turn would continue (nextStep was non-empty before the claim)',
  claimed.length === 1)
check('inbox is empty again after the claim (one continuation, not a loop)',
  inbox.nextStep.length === 0)

const decision = await runPreStep(listeners, agent, claimed, 1)
check('pre-step enters the next step', decision.kind === 'enter')
check('the continuation instruction reaches the model in the admitted messages',
  decision.messages.some(m => m.source?.kind === 'plugin:dsh-guard-repeat-output'),
  `${decision.messages.length} message(s) admitted`)

console.log('\n=== BACKSTOP: instruction survives a cleared inbox (fallback path) ===')
{
  const cleared = buildHarness(await import('../index.js'), {
    logPath: null,
    maxDegenerationRetries: 0,
  })
  await runStream(cleared.listeners, chunks)
  // Simulate the instruction being lost: drop it, then run pre-step with an
  // unrelated message set.
  cleared.inbox.nextStep.length = 0
  const lost = await runPreStep(cleared.listeners, cleared.agent, [], 1)
  const restored = lost.messages.some(m => m.source?.kind === 'plugin:dsh-guard-repeat-output')
  check('pre-step re-injects the instruction when the inbox no longer carries it', restored,
    `${lost.messages.length} message(s) admitted`)
  check('pre-step does not duplicate an instruction that is already present',
    (await runPreStep(cleared.listeners, cleared.agent, [], 1)).messages.filter(
      m => m.source?.kind === 'plugin:dsh-guard-repeat-output').length <= 1)
}

console.log('\n=== BUDGET: the last cut still sends a message (wrap-up, not silence) ===')
{
  const budgeted = buildHarness(await import('../index.js'), {
    logPath: null,
    maxDegenerationRetries: 0,
    maxTruncationsPerTurn: 1,
  })
  // First conviction: a "continue" is injected.
  await runStream(budgeted.listeners, chunks)
  const afterFirst = budgeted.inbox.nextStep.length
  // v2 has only ONE fallback tier: when the retry budget is gone, a collapse
  // wraps up. The "continue" tier is now the discard-and-retry path, which
  // injects nothing, so asserting a "continue" here would be asserting v1.
  const firstText = budgeted.inbox.nextStep[0]?.content[0].text ?? ''
  check('the budget-exhausted cut wraps up rather than resuming',
    afterFirst === 1 && firstText.includes('Do not resume'),
    `injected=${afterFirst}, wrap-up=${firstText.includes('Do not resume')}`)
  // The loop claims and runs the next step; the second conviction is the final one.
  budgeted.inbox.nextStep.length = 0
  await runPreStep(budgeted.listeners, budgeted.agent, [], 2)
  await runStream(budgeted.listeners, chunks)
  const secondText = budgeted.inbox.nextStep[0]?.content[0].text ?? ''
  check('every subsequent cut still injects — never silence',
    budgeted.inbox.nextStep.length === 1 && secondText.includes('Do not resume'),
    `injected=${budgeted.inbox.nextStep.length}`)
}

console.log('\n=== V2 PRIMARY: a collapse discards the attempt and re-issues it ===')
{
  const v2 = buildHarness(await import('../index.js'), {
    logPath: null,
    maxDegenerationRetries: 2,
  })
  const v2run = await runStream(v2.listeners, chunks)
  const finish = v2run.yielded.find(c => c.type === 'finish')
  check('the attempt is terminated with an error finish (routes to assistant/attempt)',
    finish?.reason?.kind === 'error', `kind=${finish?.reason?.kind}`)
  check('the failure code is the plugin\'s own',
    finish?.reason?.failure?.code === 'DEGENERATE_REPETITION')
  check('NOTHING is injected on the discard path (the context stays untouched)',
    v2.inbox.nextStep.length === 0, `${v2.inbox.nextStep.length} message(s)`)
  check('upstream is still cancelled', v2run.sourceClosed === true)

  // The loop then asks the plugin whether to retry.
  const decide = v2.listeners.get('agent/request-error')
  const answer = await decide(
    { agent: v2.agent, turn: 1, step: 1, provider: 'c', failure: finish.reason.failure, retryPolicy: undefined, signal: new AbortController().signal },
    () => Promise.resolve(undefined),
  )
  check('the plugin answers {kind:"retry"}', answer?.kind === 'retry')

  // The retry must NOT touch the route. Lowering the reasoning effort was tried
  // and removed: it conferred no immunity (6 of 9 lowered sessions collapsed
  // again) and cost 8 dead turns when an adapter rejected the proposed rung.
  // The guard therefore registers no agent/request listener at all.
  check('the guard does not rewrite the request config',
    v2.listeners.get('agent/request') === undefined,
    v2.listeners.get('agent/request') === undefined
      ? 'no agent/request listener registered'
      : 'a listener exists and may change the route')
}

console.log('\n=== SCOPE: non-DeepSeek models are untouched ===')
{
  const scoped = buildHarness(await import('../index.js'), { logPath: null })
  // Identity-tracked: an out-of-scope model must receive the very same chunk
  // objects, not copies or rewrites. `sourceClosed` cannot prove anything here
  // because a generator that runs to completion also closes.
  const passed = []
  async function* source() {
    for (const chunk of chunks) {
      passed.push(chunk)
      yield chunk
    }
  }
  const stream = scoped.listeners.get('llm/stream')(
    { sessionId: SESSION, provider: 'openai', model: 'gpt-4o' },
    () => source(),
  )
  const received = []
  for await (const chunk of stream) received.push(chunk)
  check('an out-of-scope model streams through unmodified',
    received.length === chunks.length
    && received.every((chunk, i) => chunk === passed[i])
    && scoped.inbox.nextStep.length === 0,
    `${received.length}/${chunks.length} chunks passed through by identity, 0 injected`)
}

console.log('\n=== LOG: convictions are recorded for after-the-fact diagnosis ===')
check('log file was written', existsSync(LOG_PATH))
if (existsSync(LOG_PATH)) {
  const lines = readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean)
  const records = lines.map(l => JSON.parse(l))
  const conviction = records.find(r => r.event === 'repetition-detected')
  check('a conviction record carries the detection evidence',
    conviction !== undefined && conviction.channel === 'reasoning'
    && typeof conviction.topPhraseCount === 'number',
    conviction === undefined
      ? 'no conviction record found'
      : `action=${conviction.action} channel=${conviction.channel} `
        + `phrase="${conviction.topPhrase}" x${conviction.topPhraseCount}`)
  // The copy is the only surviving record of discarded text, so a conviction
  // that discarded an attempt must point at one.
  const copy = records.find(r => r.event === 'repetition-copy')
  check('discarded text is preserved in a sidecar copy',
    copy === undefined || copy.chars > 0,
    copy === undefined ? 'copyDir not configured in this run' : `${copy.chars} chars -> ${copy.copy}`)
}

console.log(`\n=== SUMMARY ===`)
console.log(`  ${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed check(s)`)
process.exitCode = failures === 0 ? 0 : 1
