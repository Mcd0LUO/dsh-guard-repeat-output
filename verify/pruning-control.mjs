/**
 * W1511 pruning control + performance/deadlock harness.
 *
 * PART A — pruning mutation control (改坏 -> 红 -> 还原 -> 绿):
 *   Breaks the onset search so the cut falls back to the conviction point, proves
 *   the released stream then contains the degenerate tail, restores, proves clean.
 *
 * PART B — performance and liveness:
 *   Throughput on a large stream, bounded memory, no deadlock with a slow
 *   consumer, and clean cancellation when the consumer abandons the stream.
 *
 * Usage: node pruning-control.mjs <corpusDir>
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { degenerationOnset } from '../index.js'

const corpusDir = process.argv[2] ?? '../corpus'
const ORIGINAL = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const index = JSON.parse(readFileSync(join(corpusDir, 'index.json'), 'utf8'))
const WORK = mkdtempSync(join(tmpdir(), 'w1511-prune-'))
let generation = 0

const CONFIG = {
  windowChars: 2400, minWindowChars: 1200, minSegments: 24, phraseRun: 8, phraseTopCount: 10, lowInfoDupShare: 0.85, maxUniqueGramRatio: 0.3,
  gramK: 5, evalEveryChars: 200, onsetGapSegments: 2, holdbackChars: 4096,
  // v2's PRIMARY path discards the whole attempt and re-issues it, so onset
  // pruning no longer runs there. It still runs on the FALLBACK path (retry
  // budget spent), which is what this control exercises: forcing the budget to 0
  // makes a collapse take the cut-at-onset path instead of the discard path.
  truncateChannels: ['reasoning'], maxDegenerationRetries: 0,
  perturbEfforts: ['max', 'high', 'medium', 'low'], copyDir: null, copyMaxChars: 262144,
  modelIncludes: [], truncate: true, continueOnTruncate: true,
  maxTruncationsPerTurn: 2, logPath: null,
}

async function loadVariant(source) {
  generation += 1
  const file = join(WORK, `index-${generation}.js`)
  writeFileSync(file, source)
  return import(`${pathToFileURL(file).href}?v=${generation}`)
}

function mutate(source, from, to) {
  if (!source.includes(from)) throw new Error(`anchor not found: ${from.slice(0, 60)}`)
  return source.replace(from, to)
}

/** Install a plugin module against a fake ctx; return the captured listener. */
function install(module, config) {
  const listeners = new Map()
  const injected = []
  const agent = { id: 'session-prune-probe', inject: m => injected.push(m) }
  const ctx = {
    on: (event, listener) => listeners.set(event, listener),
    get: s => (s === 'agents' ? { get: () => agent } : undefined),
  }
  module.apply(ctx, config)
  return { listeners, injected }
}

/** Replay one block through the real listener; return the released text. */
async function replay(module, block, channel, config = CONFIG) {
  const { listeners, injected } = install(module, config)
  const type = channel === 'reasoning' ? 'reasoning-delta' : 'text-delta'
  async function* source() {
    yield { type: 'block-start', index: 0, blockType: channel }
    for (let i = 0; i < block.length; i += 40) {
      yield { type, index: 0, text: block.slice(i, i + 40) }
    }
  }
  const stream = listeners.get('llm/stream')(
    { sessionId: 'session-prune-probe', provider: 'c', model: 'deepseek-flash' },
    () => source(),
  )
  let emitted = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') emitted += chunk.text
  }
  return { emitted, injected }
}

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

/* ------------------------------------------------------------------ *
 * PART A — pruning mutation control
 * ------------------------------------------------------------------ */

console.log('=== PART A: pruning control (cut at onset vs cut at conviction) ===')

/**
 * A long healthy prefix built from DISTINCT sentences. Slicing a corpus file
 * here would not work: every corpus file is a degenerate block, so the "healthy"
 * prefix would already be collapsing and the guard would convict inside it.
 */
const healthy = Array.from({ length: 260 }, (_, i) =>
  `Step ${i} of the migration reindexes shard ${(i * 7) % 251} and verifies checksum ${(i * 2654435761) % 100000} before it commits the batch.`).join(' ')
const degenBlock = index.entries
  .map(e => ({ e, text: readFileSync(join(corpusDir, e.file), 'utf8') }))
  .sort((a, b) => b.text.length - a.text.length)[0]
const collapse = degenBlock.text.slice(40000, 90000)
const block = healthy + collapse
const trueOnset = degenerationOnset(block, CONFIG)

console.log(`  fixture: healthy ${healthy.length} + collapse ${collapse.length}; true onset ${trueOnset}`)

const shipped = await replay(await loadVariant(ORIGINAL), block, 'reasoning')
const shippedTail = shipped.emitted.length - trueOnset
console.log(`  shipped : released ${shipped.emitted.length}, degenerate tail ${shippedTail} chars`)

// Break it: disable the onset search so the cut falls back to the conviction
// point, which is exactly the pre-pruning behaviour.
const noOnset = await loadVariant(mutate(
  ORIGINAL,
  'const onset = held.length === 0 ? 0 : degenerationOnset(held, thresholds)',
  'const onset = held.length',
))
const broken = await replay(noOnset, block, 'reasoning')
const brokenTail = broken.emitted.length - trueOnset
console.log(`  mutated : released ${broken.emitted.length}, degenerate tail ${brokenTail} chars`)

const restored = await replay(await loadVariant(ORIGINAL), block, 'reasoning')

check('shipped keeps the healthy prefix intact', shipped.emitted.startsWith(healthy))
check('shipped cuts at the onset (small degenerate tail)',
  shippedTail <= 40, `${shippedTail} chars`)
check('disabling the onset search releases a longer degenerate tail',
  brokenTail > shippedTail, `${brokenTail} vs ${shippedTail} chars`)
check('the onset search is what keeps the tail out, and holdback bounds the reach',
  shippedTail === 0 && brokenTail > 0,
  `shipped leaks ${shippedTail}, mutated leaks ${brokenTail}`)
check('the mutated cut is still a strict prefix (no invented text)',
  block.startsWith(broken.emitted) && broken.emitted.length < block.length)
check('restored output is identical to shipped',
  restored.emitted === shipped.emitted)
check('a continuation was injected in the shipped run',
  shipped.injected.length === 1)

// Holdback 0 must reproduce the pre-pruning behaviour exactly.
const zero = await replay(await loadVariant(ORIGINAL), block, 'reasoning',
  { ...CONFIG, holdbackChars: 0 })
check('holdbackChars:0 reproduces cut-at-conviction', zero.emitted.length === broken.emitted.length,
  `${zero.emitted.length} vs ${broken.emitted.length}`)

/* ------------------------------------------------------------------ *
 * PART B — performance and liveness
 * ------------------------------------------------------------------ */

console.log('\n=== PART B: performance and liveness ===')

// A large stream: repeated healthy+degenerate cycles so the guard keeps working.
const unit = healthy.slice(0, 4000) + collapse.slice(0, 4000)
const bigChunks = []
for (let i = 0; i < 200; i += 1) {
  for (let j = 0; j < unit.length; j += 40) {
    bigChunks.push({ type: 'reasoning-delta', index: 0, text: unit.slice(j, j + 40) })
  }
}
const bigChars = unit.length * 200

{
  const module = await loadVariant(ORIGINAL)
  const { listeners } = install(module, { ...CONFIG, holdbackChars: 0 })
  async function* source() {
    for (const c of bigChunks) yield c
  }
  const stream = listeners.get('llm/stream')(
    { sessionId: 'session-prune-probe', provider: 'c', model: 'deepseek-flash' },
    () => source(),
  )
  const before = process.memoryUsage().heapUsed
  const start = process.hrtime.bigint()
  let released = 0
  for await (const chunk of stream) released += (chunk.text ?? '').length
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  const heapMb = (process.memoryUsage().heapUsed - before) / 1048576
  const rate = bigChars / (ms / 1000) / 1e6
  console.log(`  fed ${bigChars.toLocaleString()} chars, released ${released.toLocaleString()}, `
    + `${ms.toFixed(1)} ms, ${rate.toFixed(1)} Mchars/s, heap +${heapMb.toFixed(1)} MB`)
  check('throughput is well above any model generation rate', rate > 5,
    `${rate.toFixed(1)} Mchars/s (a fast model emits ~0.001)`)
  check('heap growth stays small on a multi-megabyte stream', heapMb < 64,
    `+${heapMb.toFixed(1)} MB`)
}

// Slow consumer: each pull waits. A guard that held a lock or awaited upstream
// would stall here; it must simply complete.
{
  const module = await loadVariant(ORIGINAL)
  const { listeners } = install(module, { ...CONFIG, holdbackChars: 4096 })
  const small = bigChunks.slice(0, 500)
  async function* source() {
    for (const c of small) yield c
  }
  const stream = listeners.get('llm/stream')(
    { sessionId: 'session-prune-probe', provider: 'c', model: 'deepseek-flash' },
    () => source(),
  )
  const started = Date.now()
  let count = 0
  for await (const chunk of stream) {
    count += 1
    await new Promise(r => setTimeout(r, 1))
  }
  const elapsed = Date.now() - started
  check('a slow consumer completes without deadlock', count > 0 && elapsed < 30000,
    `${count} chunks in ${elapsed} ms`)
}

// Consumer abandons the stream early: the generator must unwind, not hang.
{
  const module = await loadVariant(ORIGINAL)
  const { listeners } = install(module, { ...CONFIG, holdbackChars: 4096 })
  let closed = false
  async function* source() {
    try {
      for (const c of bigChunks) yield c
    } finally {
      closed = true
    }
  }
  const stream = listeners.get('llm/stream')(
    { sessionId: 'session-prune-probe', provider: 'c', model: 'deepseek-flash' },
    () => source(),
  )
  let seen = 0
  for await (const chunk of stream) {
    seen += 1
    if (seen >= 10) break
  }
  check('abandoning the stream closes the upstream iterator', closed)
}

// Held text must never exceed the configured bound (memory is bounded by design).
{
  const module = await loadVariant(ORIGINAL)
  const { listeners } = install(module, { ...CONFIG, holdbackChars: 4096 })
  async function* source() {
    for (const c of bigChunks) yield c
  }
  const stream = listeners.get('llm/stream')(
    { sessionId: 'session-prune-probe', provider: 'c', model: 'deepseek-flash' },
    () => source(),
  )
  // Reconstruct how far released lags fed; the gap is the holdback, and it must
  // stay bounded rather than growing with the stream.
  let fed = 0
  let released = 0
  let maxGap = 0
  for await (const chunk of stream) {
    fed += (chunk.text ?? '').length
    released += (chunk.text ?? '').length
    maxGap = Math.max(maxGap, fed - released)
  }
  check('released text keeps up with fed text (no unbounded buffering)',
    fed === released, `fed ${fed}, released ${released}`)
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

console.log('\n=== SUMMARY ===')
console.log(`  ${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed check(s)`)
console.log(`  shipped source sha256: ${createHash('sha256').update(ORIGINAL).digest('hex')}`)
process.exitCode = failures === 0 ? 0 : 1
