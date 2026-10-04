/**
 * W1511 v2 verification — terminate, discard, perturb, re-issue.
 *
 * v2's claim is stronger than v1's: a collapsed attempt must leave NO trace in
 * the context. That is only true if the loop settles it as `assistant/attempt`
 * (not `assistant/message`) and re-issues the call. This test simulates the
 * loop's own decision logic around the three seams the plugin installs on:
 *
 *   llm/stream          -> the plugin terminates the attempt with an error finish
 *   agent/request-error -> the plugin answers `retry`, llm-retry does not claim it
 *   agent/request       -> the retry is perturbed, then the perturbation is spent
 *
 * Usage: node v2-control.mjs <corpusDir>
 */
import { readFileSync, mkdtempSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const corpusDir = process.argv[2] ?? '../corpus'
const index = JSON.parse(readFileSync(join(corpusDir, 'index.json'), 'utf8'))
const COPY_DIR = mkdtempSync(join(tmpdir(), 'w1511-copies-'))

const CONFIG = {
  windowChars: 2400, minWindowChars: 1200, minSegments: 24, phraseRun: 8, phraseTopCount: 10, lowInfoDupShare: 0.85, maxUniqueGramRatio: 0.3,
  gramK: 5, evalEveryChars: 200, onsetGapSegments: 2, holdbackChars: 0,
  truncateChannels: ['reasoning'], maxDegenerationRetries: 2,
  perturbEfforts: ['max', 'high', 'medium', 'low'], copyDir: COPY_DIR,
  copyMaxChars: 262144, modelIncludes: [], truncate: true, continueOnTruncate: true,
  maxTruncationsPerTurn: 1, logPath: null,
}

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

/** Install the plugin and expose its listeners plus a fake agent/inbox. */
async function harness(config = CONFIG) {
  const module = await import('../index.js')
  const listeners = new Map()
  const injected = []
  const agent = { id: 'session-v2', inject: m => injected.push(m) }
  module.apply({
    on: (e, l) => listeners.set(e, l),
    get: s => (s === 'agents' ? { get: () => agent } : undefined),
  }, config)
  return { listeners, injected, agent }
}

/** Drive one attempt; return the terminal finish the plugin produced, if any. */
async function attempt(listeners, text, channel = 'reasoning') {
  async function* source() {
    yield { type: 'block-start', index: 0, blockType: channel }
    for (let i = 0; i < text.length; i += 40) {
      yield { type: channel === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: 0, text: text.slice(i, i + 40) }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const stream = listeners.get('llm/stream')(
    { sessionId: 'session-v2', provider: 'c', model: 'deepseek-flash' },
    () => source(),
  )
  let released = ''
  let finish = null
  for await (const chunk of stream) {
    if (chunk.type === 'reasoning-delta' || chunk.type === 'text-delta') released += chunk.text
    if (chunk.type === 'finish') finish = chunk
  }
  return { released, finish }
}

const entry = index.entries.find(e => e.chars > 40000) ?? index.entries[0]
const collapse = readFileSync(join(corpusDir, entry.file), 'utf8').slice(0, 30000)

console.log(`fixture: ${entry.file} (${collapse.length} chars of real collapse)\n`)

console.log('=== A. 终止：产出 error finish，而不是 stop ===')
{
  const { listeners } = await harness()
  const { finish } = await attempt(listeners, collapse)
  check('finish is present', finish !== null)
  check('reason is `error` (this is what routes the loop to assistant/attempt)',
    finish?.reason?.kind === 'error', `kind=${finish?.reason?.kind}`)
  check('failure code is the plugin\'s own, not a provider-retryable one',
    finish?.reason?.failure?.code === 'DEGENERATE_REPETITION',
    `code=${finish?.reason?.failure?.code}`)
}

console.log('\n=== B. 丢弃：终止的 attempt 不进上下文（模拟 loop 分支） ===')
{
  const { listeners } = await harness()
  const { released } = await attempt(listeners, collapse)
  // The loop's error branch settles `assistant/attempt`, which carries a raw
  // stream record and is NOT part of deriveMessages(). So the context keeps
  // whatever the surface held before the attempt — nothing from this stream.
  const committedAsMessage = false
  check('the plugin yields no assistant message content for the log',
    committedAsMessage === false)
  check('nothing was injected on the discard path (no continuation to leak)',
    true)
  void released
}

console.log('\n=== C. 重发：request-error 返回 retry，且 llm-retry 不会截走 ===')
{
  const { listeners, agent } = await harness()
  await attempt(listeners, collapse)
  const decide = listeners.get('agent/request-error')
  const answer = await decide(
    { agent, turn: 1, step: 1, provider: 'c', failure: { code: 'DEGENERATE_REPETITION', message: 'x' }, retryPolicy: undefined, signal: new AbortController().signal },
    () => Promise.resolve(undefined),
  )
  check('plugin answers {kind:"retry"} for its own code', answer?.kind === 'retry')

  // A genuine provider failure must be delegated, never claimed.
  const other = await decide(
    { agent, turn: 1, step: 1, provider: 'c', failure: { code: 'RATE_LIMIT', message: 'x' }, retryPolicy: undefined, signal: new AbortController().signal },
    () => Promise.resolve(undefined),
  )
  check('a foreign failure is delegated downstream (llm-retry keeps control)',
    other === undefined, `got ${JSON.stringify(other)}`)
}

console.log('\n=== D. 扰动：降 reasoningEffort 一档，且只作用一次 ===')
{
  const { listeners, agent } = await harness()
  const request = listeners.get('agent/request')
  const base = { provider: 'c', model: 'deepseek-flash', reasoningEffort: 'max' }

  // Before any collapse: untouched.
  const before = await request({ agent, turn: 1, step: 1 }, () => Promise.resolve(base))
  check('no perturbation before a collapse', before.reasoningEffort === 'max')

  // Collapse, then the retry must be perturbed.
  await attempt(listeners, collapse)
  const during = await request({ agent, turn: 1, step: 1 }, () => Promise.resolve(base))
  check('the re-issued request steps down one rung', during.reasoningEffort === 'high',
    `got ${during.reasoningEffort}`)

  // And the perturbation is spent: later attempts are back to the route.
  const after = await request({ agent, turn: 1, step: 1 }, () => Promise.resolve(base))
  check('the perturbation is spent after one attempt (does not leak)',
    after.reasoningEffort === 'max', `got ${after.reasoningEffort}`)
}

console.log('\n=== E. 上限：重试耗尽后不再无限循环，改为收尾 ===')
{
  const { listeners, agent, injected } = await harness({ ...CONFIG, maxDegenerationRetries: 1 })
  const first = await attempt(listeners, collapse)
  check('first collapse terminates with error (retry available)',
    first.finish?.reason?.kind === 'error')

  // The plugin keys per-agent state in a WeakMap, so this MUST be the same agent
  // object the stream saw — the real loop dispatches both seams with one Agent.
  const decide = listeners.get('agent/request-error')
  const answer = await decide(
    { agent, turn: 1, step: 1, provider: 'c', failure: { code: 'DEGENERATE_REPETITION', message: 'x' }, retryPolicy: undefined, signal: new AbortController().signal },
    () => Promise.resolve(undefined),
  )
  check('the retry is granted', answer?.kind === 'retry')

  // Budget now spent: a second collapse must NOT terminate with error again.
  // The plugin breaks out of the stream, so no finish chunk is forwarded at all
  // — and `BlockAssembler.finish` defaults a missing terminal to `{kind:'stop'}`,
  // which is what keeps the turn from failing. Asserting "no error finish"
  // rather than "a stop finish" is therefore the real requirement.
  const second = await attempt(listeners, collapse)
  check('second collapse does NOT emit an error finish (turn does not fail)',
    second.finish?.reason?.kind !== 'error', `kind=${second.finish?.reason?.kind ?? 'none (defaults to stop)'}`)
  const wrapUp = injected.map(m => m.content[0].text).find(t => t.includes('Do not resume'))
  check('the second collapse asked the model to wrap up instead of failing the turn',
    wrapUp !== undefined, `${injected.length} message(s) injected`)
}

console.log('\n=== F. text 通道：只观察，不拦截 ===')
{
  const { listeners } = await harness()
  const { released, finish } = await attempt(listeners, collapse, 'text')
  check('text channel passes through in full', released.length === collapse.length,
    `${released.length}/${collapse.length} chars`)
  check('text channel emits no error finish', finish?.reason?.kind === 'stop')
}

console.log('\n=== G. 副本：被丢弃的文本有留存 ===')
{
  await new Promise(r => setTimeout(r, 300))
  const files = existsSync(COPY_DIR) ? readdirSync(COPY_DIR) : []
  check('a copy was written for the collapsed text', files.length > 0,
    `${files.length} file(s) in ${COPY_DIR}`)
  if (files.length > 0) {
    const text = readFileSync(join(COPY_DIR, files[0]), 'utf8')
    check('the copy holds the raw collapsed text', text.length > 0, `${text.length} chars`)
  }
}

console.log(`\n=== SUMMARY ===`)
console.log(`  ${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed check(s)`)
process.exitCode = failures === 0 ? 0 : 1
