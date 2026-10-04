/**
 * W1511 — the two questions, answered by measurement.
 *
 *   Q1: does it automatically send "continue"?
 *   Q2: does it prune?
 *
 * Feeds a real degenerate block through the SHIPPED plugin (real listeners, fake
 * ctx) and reports, per conviction, the message injected and the characters
 * withheld from the downstream stream.
 *
 * Usage: node answer-two-questions.mjs <corpusDir>
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { degenerationOnset } from '../index.js'

const corpusDir = process.argv[2] ?? '../corpus'
const index = JSON.parse(readFileSync(join(corpusDir, 'index.json'), 'utf8'))

const CONFIG = {
  windowChars: 2400, minWindowChars: 1200, minSegments: 24, phraseRun: 8, phraseTopCount: 10, lowInfoDupShare: 0.85, maxUniqueGramRatio: 0.3,
  gramK: 5, evalEveryChars: 200, onsetGapSegments: 2, holdbackChars: 4096,
  modelIncludes: [], truncate: true, continueOnTruncate: true,
  maxTruncationsPerTurn: 2, logPath: null,
}

/** Healthy prefix (distinct sentences) so the onset is unambiguous. */
const healthy = Array.from({ length: 200 }, (_, i) =>
  `Step ${i} reindexes shard ${(i * 7) % 251} and verifies checksum ${(i * 2654435761) % 100000} before committing.`).join(' ')

// A real degenerate block from the frozen corpus.
const entry = index.entries.find(e => e.chars > 40000) ?? index.entries[0]
const block = healthy + readFileSync(join(corpusDir, entry.file), 'utf8')
const trueOnset = degenerationOnset(block, CONFIG)

/** Replay one stream; return what was released and what was injected. */
async function replay(holdbackChars) {
  const module = await import('../index.js')
  const listeners = new Map()
  const injected = []
  const agent = { id: 'session-q', inject: m => injected.push(m) }
  module.apply({
    on: (e, l) => listeners.set(e, l),
    get: s => (s === 'agents' ? { get: () => agent } : undefined),
  }, { ...CONFIG, holdbackChars })

  async function* source() {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    for (let i = 0; i < block.length; i += 40) {
      yield { type: 'reasoning-delta', index: 0, text: block.slice(i, i + 40) }
    }
  }
  const stream = listeners.get('llm/stream')(
    { sessionId: 'session-q', provider: 'c', model: 'deepseek-flash' },
    () => source(),
  )
  let released = ''
  for await (const chunk of stream) {
    if (chunk.type === 'reasoning-delta') released += chunk.text
  }
  return { released, injected }
}

console.log(`fixture: healthy ${healthy.length} + real block ${entry.chars} = ${block.length} chars`)
console.log(`true degeneration onset: ${trueOnset}\n`)

/* ---- Q2: pruning ---- */
const off = await replay(0)
const on = await replay(4096)
const tailOff = off.released.length - trueOnset
const tailOn = on.released.length - trueOnset

console.log('Q2 — 剪枝?')
console.log(`  holdback 0    (旧行为): 释放 ${off.released.length} 字符，其中退化 ${tailOff} 字符`)
console.log(`  holdback 4096 (现行为): 释放 ${on.released.length} 字符，其中退化 ${tailOn} 字符`)
console.log(`  -> 退化文本少放出 ${tailOff - tailOn} 字符 (${((1 - tailOn / Math.max(1, tailOff)) * 100).toFixed(1)}%)\n`)

/* ---- Q1: automatic continue ---- */
console.log('Q1 — 自动发送继续?')
console.log(`  单次流触发定罪后注入 ${on.injected.length} 条消息:`)
for (const [i, m] of on.injected.entries()) {
  const text = m.content[0].text
  const kind = text.includes('Do not resume') ? 'WRAP-UP' : 'continue'
  console.log(`    #${i + 1} [${kind}] ${m.source.summary}`)
}

// Every truncation in a turn must inject — the silent third was the reported bug.
const budgeted = { ...CONFIG, maxTruncationsPerTurn: 1 }
const module = await import('../index.js')
const listeners = new Map()
const injected = []
const agent = { id: 'session-q2', inject: m => injected.push(m) }
module.apply({
  on: (e, l) => listeners.set(e, l),
  get: s => (s === 'agents' ? { get: () => agent } : undefined),
}, { ...budgeted, holdbackChars: 4096 })
async function runOnce() {
  async function* source() {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    for (let i = 0; i < block.length; i += 40) {
      yield { type: 'reasoning-delta', index: 0, text: block.slice(i, i + 40) }
    }
  }
  const st = listeners.get('llm/stream')(
    { sessionId: 'session-q2', provider: 'c', model: 'deepseek-flash' },
    () => source(),
  )
  for await (const c of st) { /* drain */ }
}
await runOnce(); await runOnce(); await runOnce()
console.log(`\n  同一 turn 内 3 次定罪 (maxTruncationsPerTurn=1):`)
for (const [i, m] of injected.entries()) {
  const kind = m.content[0].text.includes('Do not resume') ? 'WRAP-UP' : 'continue'
  console.log(`    #${i + 1} [${kind}]`)
}
console.log(`  注入 ${injected.length}/3 次 —— 无静默截断: ${injected.length === 3 ? 'YES' : 'NO'}`)
