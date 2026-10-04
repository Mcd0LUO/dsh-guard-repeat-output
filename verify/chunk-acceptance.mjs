/**
 * W1511 chunk-independence acceptance.
 *
 * The detector judges a fixed-size window, so WHERE it evaluates must not depend
 * on how the caller chunks the stream — otherwise the same text convicts or
 * escapes purely by accident of the provider's SSE framing. This is not
 * hypothetical: on a real 4832-char collapse, chunk 3 and chunk 7 missed it
 * entirely while chunk 40 convicted.
 *
 * Asserts, for every corpus block and every chunk size:
 *   - it is still detected (no chunking may turn a collapse into a miss)
 *   - `convictionAt` is the SAME for all chunk sizes (grid independence)
 * and, for every legitimate negative, that nothing convicts at any chunk size.
 *
 * Usage: node chunk-acceptance.mjs <corpusDir> [legitDir]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { RepetitionGuard } from '../index.js'

const corpusDir = process.argv[2] ?? '../corpus'
const legitDir = process.argv[3] ?? '/tmp/w1510/legit'
const CHUNKS = [1, 3, 7, 13, 40, 64, 100, 200, 512, 1000]

const index = JSON.parse(readFileSync(join(corpusDir, 'index.json'), 'utf8'))

/** Feed text at one chunk size; return the grid point that convicted, or null. */
function run(text, channel, size) {
  const guard = new RepetitionGuard()
  for (let i = 0; i < text.length; i += size) {
    if (guard.push(text.slice(i, i + size), channel) !== null) break
  }
  return guard.convictionAt(channel)
}

let misses = 0
let unstable = 0
let checked = 0
const unstableExamples = []

for (const entry of index.entries) {
  const text = readFileSync(join(corpusDir, entry.file), 'utf8')
  const points = new Set()
  let missed = false
  for (const size of CHUNKS) {
    const at = run(text, entry.channel, size)
    if (at === null) { missed = true; break }
    points.add(at)
  }
  checked += 1
  if (missed) {
    misses += 1
    console.log(`  MISS  ${entry.file} — a chunk size turned a collapse into a miss`)
    continue
  }
  if (points.size !== 1) {
    unstable += 1
    if (unstableExamples.length < 5) {
      unstableExamples.push(`${entry.file}: ${[...points].join(',')}`)
    }
  }
}

console.log(`\n=== POSITIVES ===`)
console.log(`  blocks checked        : ${checked}`)
console.log(`  missed at some chunk  : ${misses}`)
console.log(`  grid point unstable   : ${unstable}`)
for (const e of unstableExamples) console.log(`      ${e}`)

let negatives = 0
let falsePositives = 0
try {
  for (const file of readdirSync(legitDir).filter(f => f.endsWith('.txt'))) {
    const text = readFileSync(join(legitDir, file), 'utf8')
    if (text.length < 1200) continue
    negatives += 1
    for (const size of CHUNKS) {
      if (run(text, 'reasoning', size) !== null) {
        falsePositives += 1
        console.log(`  FALSE+ ${file} at chunk ${size}`)
        break
      }
    }
  }
} catch {
  console.log(`  (negative corpus not found at ${legitDir}; skipped)`)
}

console.log(`\n=== NEGATIVES ===`)
console.log(`  legitimate segments   : ${negatives}`)
console.log(`  false positives       : ${falsePositives}`)

const ok = misses === 0 && unstable === 0 && falsePositives === 0
console.log(`\n  ${ok ? 'PASS' : 'FAIL'} — every collapse detected identically at every chunk size`)
process.exitCode = ok ? 0 : 1
