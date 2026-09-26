/**
 * W1511 task 2 — does planning-filler density RISE BEFORE the collapse?
 *
 * The correlation (degenerate session has ~1.9x the filler density of the
 * normal one) cannot distinguish cause from effect: the collapse tail itself is
 * made of filler, so a post-hoc density measurement is inflated by its own
 * outcome. The only way to separate them is to look exclusively at the window
 * BEFORE the first conviction.
 *
 * If density is already elevated before the collapse, density is a candidate
 * cause (or an early marker). If it is unremarkable before and only jumps at the
 * collapse, density is an EFFECT and the correlation is an artefact.
 *
 * Usage: node density-before.mjs <sessionPath> <convictionIsoTime> [windowChars]
 */
import { execFileSync } from 'node:child_process'

const sessionPath = process.argv[2]
const convictionTime = Date.parse(process.argv[3])
const WINDOW = Number(process.argv[4] ?? 20000)

/** The filler vocabulary W1510 proposed. */
const FILLER = /\b(let me|i'll|i will|now|ok|okay|writing|producing|let's)\b/gi
const ACTION = /\b(writing|producing)\b/gi

function readEvents(path) {
  const out = execFileSync('sudo', ['-n', 'zstd', '-dc', path], {
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString('utf8')
  const events = []
  for (const line of out.split('\n')) {
    if (line.length === 0 || !line.includes('"assistant/message"')) continue
    try {
      events.push(JSON.parse(line))
    } catch { /* ignore */ }
  }
  return events
}

/** Reasoning text of one assistant message, or ''. */
function reasoningOf(event) {
  let text = ''
  for (const block of event?.data?.message?.content ?? []) {
    if (block?.type === 'reasoning') text += block.text ?? ''
  }
  return text
}

const events = readEvents(sessionPath)
const withReasoning = events
  .map(e => ({ time: e.time, turn: e.data?.turn, step: e.data?.step, text: reasoningOf(e) }))
  .filter(e => e.text.length > 0)

console.log(`session: ${sessionPath.split('/').slice(-2)[0]}`)
console.log(`reasoning blocks: ${withReasoning.length}`)
console.log(`conviction time : ${new Date(convictionTime).toISOString()}\n`)

const before = withReasoning.filter(e => e.time < convictionTime)
const after = withReasoning.filter(e => e.time >= convictionTime)

/** Density per 10k chars over a set of blocks. */
function density(blocks, re) {
  const chars = blocks.reduce((a, b) => a + b.text.length, 0)
  let hits = 0
  for (const b of blocks) hits += (b.text.match(re) ?? []).length
  return { chars, hits, per10k: chars === 0 ? 0 : (hits / chars) * 10000 }
}

console.log('=== 全量（退化点前 / 后）===')
for (const [label, blocks] of [['BEFORE', before], ['AFTER', after]]) {
  const d = density(blocks, FILLER)
  const a = density(blocks, ACTION)
  console.log(`  ${label.padEnd(7)} blocks=${String(blocks.length).padStart(3)} `
    + `chars=${String(d.chars).padStart(8)} filler=${String(d.hits).padStart(5)} `
    + `per10k=${d.per10k.toFixed(1).padStart(6)}  actionPer10k=${a.per10k.toFixed(1)}`)
}

console.log(`\n=== 滚动窗口（每 ${WINDOW} 字符 reasoning，退化点之前）===`)
// Walk the pre-collapse reasoning in character order, reporting density per
// fixed-size window, so a rising trend is visible rather than a single average.
let buf = ''
let index = 0
const rows = []
for (const block of before) {
  buf += block.text
  while (buf.length >= WINDOW) {
    const win = buf.slice(0, WINDOW)
    buf = buf.slice(WINDOW)
    index += 1
    const d = density([{ text: win }], FILLER)
    rows.push({ index, per10k: d.per10k, hits: d.hits })
  }
}
for (const r of rows) {
  const bar = '#'.repeat(Math.min(60, Math.round(r.per10k / 2)))
  console.log(`  win${String(r.index).padStart(3)} per10k=${r.per10k.toFixed(1).padStart(6)} ${bar}`)
}
if (rows.length >= 4) {
  const half = Math.floor(rows.length / 2)
  const early = rows.slice(0, half).reduce((a, r) => a + r.per10k, 0) / half
  const late = rows.slice(half).reduce((a, r) => a + r.per10k, 0) / (rows.length - half)
  console.log(`\n  前半均值=${early.toFixed(1)}  后半均值=${late.toFixed(1)}  `
    + `趋势=${late > early * 1.2 ? '上升' : late < early * 0.8 ? '下降' : '平稳'}`)
}
