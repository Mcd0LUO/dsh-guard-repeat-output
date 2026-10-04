/**
 * W1511 pruning-gap measurement.
 *
 * The card asks to truncate "to before the degeneration began". An online
 * detector cannot know text is degenerate until it has seen enough of it, so the
 * conviction point necessarily LAGS the degeneration onset. This measures that
 * lag on the frozen corpus: how many characters of already-emitted text are
 * degenerate by the time the detector convicts.
 *
 *   emittedDegenerate = triggerAtChar - onset
 *
 * Onset is estimated as the start of the maximal trailing run of the emitted
 * prefix that is dominated by repeated segments (>=85% of segments in that run
 * are repeats, matching the detector's lowInfoDupShare).
 *
 * Usage: node measure-pruning-gap.mjs <corpusDir>
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const corpusDir = process.argv[2] ?? '../corpus'
const index = JSON.parse(readFileSync(join(corpusDir, 'index.json'), 'utf8'))

const SEG = /[^.!?\n;。！？；]+/g
const NON_WORD = /[^0-9a-z\u4e00-\u9fff]+/g

/** Segments of a text slice, with their absolute start offsets. */
function segmentsWithOffsets(text) {
  const out = []
  for (const match of text.matchAll(SEG)) {
    const norm = match[0].toLowerCase().replace(/\s+/g, ' ').trim()
    if (norm.length < 12) continue
    out.push({ start: match.index, text: norm })
  }
  return out
}

/**
 * Estimate where the degeneration began inside the emitted prefix: the start of
 * the maximal trailing run whose segments are dominated by repeats.
 */
function onsetOf(text, triggerAtChar) {
  const emitted = text.slice(0, triggerAtChar)
  const segs = segmentsWithOffsets(emitted)
  if (segs.length === 0) return triggerAtChar

  const counts = new Map()
  for (const s of segs) counts.set(s.text, (counts.get(s.text) ?? 0) + 1)

  // Walk backward from the conviction point while the running duplicate share
  // stays at or above the low-information threshold.
  let repeats = 0
  let total = 0
  let onset = segs[segs.length - 1].start
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    total += 1
    if (counts.get(segs[i].text) > 1) repeats += 1
    if (repeats / total < 0.85) break
    onset = segs[i].start
  }
  return onset
}

const rows = []
for (const entry of index.entries) {
  const text = readFileSync(join(corpusDir, entry.file), 'utf8')
  const onset = onsetOf(text, entry.triggerAtChar)
  rows.push({
    file: entry.file,
    channel: entry.channel,
    chars: entry.chars,
    triggerAtChar: entry.triggerAtChar,
    onset,
    emittedDegenerate: entry.triggerAtChar - onset,
    kept: entry.triggerAtChar,
  })
}

rows.sort((a, b) => b.emittedDegenerate - a.emittedDegenerate)

const totalEmitted = rows.reduce((a, r) => a + r.emittedDegenerate, 0)
const totalKept = rows.reduce((a, r) => a + r.kept, 0)
const totalChars = rows.reduce((a, r) => a + r.chars, 0)

console.log(`blocks: ${rows.length}\n`)
console.log('worst 12 by already-emitted degenerate text:')
console.log(`  ${'emittedDeg'.padStart(10)} ${'triggerAt'.padStart(10)} ${'onset'.padStart(9)} ${'blockChars'.padStart(11)}  channel`)
for (const r of rows.slice(0, 12)) {
  console.log(`  ${String(r.emittedDegenerate).padStart(10)} ${String(r.triggerAtChar).padStart(10)} ${String(r.onset).padStart(9)} ${String(r.chars).padStart(11)}  ${r.channel}`)
}

console.log(`\ntotals across corpus:`)
console.log(`  block chars (full)              : ${totalChars.toLocaleString()}`)
console.log(`  emitted before conviction       : ${totalKept.toLocaleString()}`)
console.log(`  of which degenerate (the gap)   : ${totalEmitted.toLocaleString()}`)
console.log(`  gap as share of emitted         : ${(totalEmitted / totalKept * 100).toFixed(1)}%`)
console.log(`  gap as share of full corpus     : ${(totalEmitted / totalChars * 100).toFixed(1)}%`)

const zero = rows.filter(r => r.emittedDegenerate === 0).length
console.log(`\nblocks where onset == conviction (no gap): ${zero}/${rows.length}`)
