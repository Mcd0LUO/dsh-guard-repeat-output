/**
 * W1511 pruning sweep — how much degenerate text does holdback actually remove?
 *
 * Replays every corpus block through the SHIPPED guardStream (via a fake ctx, so
 * the real wiring is exercised) at several `holdbackChars` settings and measures:
 *
 *   emitted      — characters actually released downstream
 *   degenerate   — of those, how many are at/after the true onset (the pollution)
 *   pruned       — characters withheld from downstream
 *
 * The true onset is computed over the WHOLE block (offline, unbounded) as the
 * reference; a real online guard can only see its holdback, so its cut is
 * best-effort within that bound. The gap between them is the honest cost of
 * bounded memory.
 *
 * Usage: node measure-pruning.mjs <corpusDir>
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const corpusDir = process.argv[2] ?? '../corpus'
const index = JSON.parse(readFileSync(join(corpusDir, 'index.json'), 'utf8'))

const { degenerationOnset } = await import('../index.js')
const DEFAULTS = {
  windowChars: 2400, minWindowChars: 1200, minSegments: 24, phraseRun: 8, phraseTopCount: 10, lowInfoDupShare: 0.85, maxUniqueGramRatio: 0.3,
  gramK: 5, evalEveryChars: 200, onsetGapSegments: 2, modelIncludes: [], truncate: true,
  continueOnTruncate: true, maxTruncationsPerTurn: 2, logPath: null,
}

/** Install the shipped plugin against a fake ctx and capture its stream listener. */
async function install(config) {
  const module = await import('../index.js')
  const listeners = new Map()
  const injected = []
  const agent = { id: 'session-pruning-probe', inject: m => injected.push(m) }
  const ctx = {
    on: (event, listener) => listeners.set(event, listener),
    get: s => (s === 'agents' ? { get: () => agent } : undefined),
  }
  module.apply(ctx, config)
  return { listeners, injected }
}

/** Feed one block through the real listener; return what was released. */
async function replay(block, channel, holdbackChars) {
  const { listeners, injected } = await install({ ...DEFAULTS, holdbackChars, logPath: null })
  const type = channel === 'reasoning' ? 'reasoning-delta' : 'text-delta'
  const chunks = [{ type: 'block-start', index: 0, blockType: channel }]
  for (let i = 0; i < block.length; i += 40) {
    chunks.push({ type, index: 0, text: block.slice(i, i + 40) })
  }
  async function* source() {
    for (const c of chunks) yield c
  }
  const stream = listeners.get('llm/stream')(
    { sessionId: 'session-pruning-probe', provider: 'celestia', model: 'deepseek-flash' },
    () => source(),
  )
  let emitted = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') emitted += chunk.text
  }
  return { emitted, injected }
}

const SWEEP = [0, 1200, 2400, 4096, 6144, 8192]

console.log(`blocks: ${index.entries.length}\n`)
console.log(`${'holdback'.padStart(9)} ${'emitted'.padStart(12)} ${'degenerate'.padStart(12)} ${'pollution%'.padStart(11)} ${'pruned'.padStart(12)} ${'exactCut'.padStart(9)}`)

const summary = []
for (const holdbackChars of SWEEP) {
  let emittedTotal = 0
  let degenerateTotal = 0
  let prunedTotal = 0
  let exact = 0
  let blocks = 0

  for (const entry of index.entries) {
    const block = readFileSync(join(corpusDir, entry.file), 'utf8')
    // Offline reference: the true onset over the whole block.
    const trueOnset = degenerationOnset(block, DEFAULTS)
    const { emitted } = await replay(block, entry.channel, holdbackChars)
    emittedTotal += emitted.length
    degenerateTotal += Math.max(0, emitted.length - trueOnset)
    prunedTotal += block.length - emitted.length
    if (emitted.length === trueOnset) exact += 1
    blocks += 1
  }

  const pollution = emittedTotal === 0 ? 0 : degenerateTotal / emittedTotal * 100
  summary.push({ holdbackChars, emittedTotal, degenerateTotal, pollution, prunedTotal, exact, blocks })
  console.log(`${String(holdbackChars).padStart(9)} ${emittedTotal.toLocaleString().padStart(12)} ${degenerateTotal.toLocaleString().padStart(12)} ${(pollution.toFixed(2) + '%').padStart(11)} ${prunedTotal.toLocaleString().padStart(12)} ${(exact + '/' + blocks).padStart(9)}`)
}

console.log('\nexactCut = blocks whose released prefix ends exactly at the true onset')
const base = summary[0]
const best = summary[summary.length - 1]
console.log(`\nholdback 0 (pre-pruning) pollution : ${base.degenerateTotal.toLocaleString()} chars (${base.pollution.toFixed(2)}%)`)
console.log(`holdback ${best.holdbackChars} pollution            : ${best.degenerateTotal.toLocaleString()} chars (${best.pollution.toFixed(2)}%)`)
console.log(`reduction                          : ${((1 - best.degenerateTotal / base.degenerateTotal) * 100).toFixed(1)}%`)
