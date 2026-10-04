/**
 * W1511 calibration harness.
 *
 * Drives the SHIPPED detector (`../index.js`) — not a reimplementation — over:
 *   - 4 real degenerate samples (positive corpus)
 *   - 1932 real legitimate segments (negative corpus)
 * and reports hit position, missed detections, and false positives.
 *
 * Usage: node calibrate.mjs <corpusRoot>
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { RepetitionGuard } from '../index.js'

const ROOT = process.argv[2] ?? '/tmp/w1510'
const DELTA = 40 // realistic streamed delta size in characters

/** Feed one text through the guard as a delta stream; report where it convicted. */
function streamThrough(text, channel) {
  const guard = new RepetitionGuard()
  let seen = 0
  for (let i = 0; i < text.length; i += DELTA) {
    const delta = text.slice(i, i + DELTA)
    seen += delta.length
    const evidence = guard.push(delta, channel)
    if (evidence !== null) return { evidence, at: seen }
  }
  return { evidence: null, at: null }
}

console.log(`detector: shipped ../index.js   corpus: ${ROOT}`)
console.log(`delta size: ${DELTA} chars\n`)

/* ---------------- positives: 4 real degenerate samples ---------------- */

const POSITIVES = [
  ['deg0-seq2502.txt', 'unreg', 'varied-phrasing collapse'],
  ['deg1-seq2608.txt', 'unreg', 'pure repetition collapse'],
  ['deg2-seq2680.txt', 'unreg', 'varied-phrasing collapse'],
  ['mine-degenerate.txt', 'flat', 'alternating two-phrase collapse'],
]

console.log('=== POSITIVES (real degenerate output) ===')
let posHit = 0
for (const [file, sub, label] of POSITIVES) {
  const path = sub === 'flat' ? `${ROOT}/${file}` : `${ROOT}/${sub}/${file}`
  const text = readFileSync(path, 'utf8')
  // Sample A's collapse lived entirely in the reasoning channel; the others are
  // body text. Judge each sample on the channel that actually carried it.
  const channel = file.startsWith('deg1') || file.startsWith('deg2') || file.startsWith('deg0')
    ? 'reasoning'
    : 'text'
  const { evidence, at } = streamThrough(text, channel)
  if (evidence === null) {
    console.log(`  MISS  ${file.padEnd(22)} len=${String(text.length).padStart(8)}  ${label}`)
    continue
  }
  posHit += 1
  const pct = ((at / text.length) * 100).toFixed(2)
  const saved = (100 - Number(pct)).toFixed(1)
  console.log(`  HIT   ${file.padEnd(22)} len=${String(text.length).padStart(8)}  `
    + `convicted@${String(at).padStart(8)} (${pct}% in, saved ${saved}%)  `
    + `chan=${evidence.channel} kind=${evidence.kind}`)
  console.log(`        phrase="${evidence.topPhrase.slice(0, 44)}" x${evidence.topPhraseCount} `
    + `run=${evidence.longestRun} segs=${evidence.segments} `
    + `dup=${evidence.duplicateShare.toFixed(3)} gram=${evidence.uniqueGramRatio.toFixed(3)}`)
}
console.log(`  -> detected ${posHit}/${POSITIVES.length}\n`)

/* ---------------- negatives: real legitimate segments ---------------- */

/**
 * Hash of the positive corpus. The harvested `reasoning/` directory turned out to
 * contain three byte-identical copies of the degenerate samples themselves, so a
 * negative file matching a positive is the same file, not a false positive.
 * Excluding by content hash (not by filename) keeps the negative count honest.
 */
const POSITIVE_HASHES = new Set(POSITIVES.map(([file, sub]) => {
  const path = sub === 'flat' ? `${ROOT}/${file}` : `${ROOT}/${sub}/${file}`
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}))

function scanDir(dir, channel) {
  let files
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.txt'))
  } catch {
    return { files: 0, skipped: 0, fp: 0, examples: [] }
  }
  let fp = 0
  let skipped = 0
  const examples = []
  for (const f of files) {
    const bytes = readFileSync(`${dir}/${f}`)
    if (POSITIVE_HASHES.has(createHash('sha256').update(bytes).digest('hex'))) {
      skipped += 1
      continue
    }
    const text = bytes.toString('utf8')
    const { evidence, at } = streamThrough(text, channel)
    if (evidence !== null) {
      fp += 1
      if (examples.length < 5) {
        examples.push(`${f} len=${text.length} at=${at} "${evidence.topPhrase.slice(0, 40)}"`)
      }
    }
  }
  return { files: files.length, skipped, fp, examples }
}

console.log('=== NEGATIVES (real legitimate output) ===')
const legit = scanDir(`${ROOT}/legit`, 'reasoning')
const reasoning = scanDir(`${ROOT}/reasoning`, 'reasoning')
for (const [name, r] of [['legit/', legit], ['reasoning/', reasoning]]) {
  const note = r.skipped > 0 ? `  (excluded ${r.skipped} byte-identical copies of the positive corpus)` : ''
  console.log(`  ${name.padEnd(12)} files=${String(r.files).padStart(5)}  FALSE_POSITIVES=${r.fp}${note}`)
  for (const e of r.examples) console.log(`      ${e}`)
}
const totalNeg = legit.files + reasoning.files - legit.skipped - reasoning.skipped
const totalFp = legit.fp + reasoning.fp
console.log(`  -> ${totalFp} false positives over ${totalNeg} distinct real legitimate segments\n`)

/* ---------------- hard negatives: hand-built adversarial cases ---------------- */

const HARD = [
  ['report citing one command block 12x',
    'The verification pipeline runs this exact command before every release. '
    + 'pnpm check:fast. '.repeat(12)
    + 'That gate is the only thing standing between a broken build and production, and it has '
    + 'caught three regressions this quarter alone, each of which would have shipped a crash to '
    + 'every user of the desktop client. The team agreed to keep it mandatory.'],
  ['many small functions returning null',
    Array.from({ length: 14 }, (_, i) => `export function guard${i}(value) { if (value === undefined) return null; return value; }`).join('\n')],
  ['long healthy prose, no repetition',
    'The detector watches a bounded rolling window rather than the whole reply, which keeps both '
    + 'its running time and its memory constant no matter how long the model talks. A conviction '
    + 'requires two independent signals to agree, and that agreement is what separates a genuine '
    + 'collapse from output that is merely repetitive. Each channel keeps its own window.'],
]

console.log('=== HARD NEGATIVES (hand-built) ===')
let hardFp = 0
for (const [label, text] of HARD) {
  const { evidence, at } = streamThrough(text, 'text')
  if (evidence === null) {
    console.log(`  clean  ${label}`)
  } else {
    hardFp += 1
    console.log(`  FALSE+ ${label}  at=${at} "${evidence.topPhrase.slice(0, 40)}"`)
  }
}
console.log(`  -> ${hardFp} false positives over ${HARD.length} hard negatives\n`)

/* ---------------- summary ---------------- */

console.log('=== SUMMARY ===')
console.log(`  real degenerate detected : ${posHit}/${POSITIVES.length}`)
console.log(`  real legit false alarms  : ${totalFp}/${totalNeg}`)
console.log(`  hard negative false alarm: ${hardFp}/${HARD.length}`)
const ok = posHit === POSITIVES.length && totalFp === 0 && hardFp === 0
console.log(`  VERDICT: ${ok ? 'PASS' : 'FAIL'}`)
process.exitCode = ok ? 0 : 1
