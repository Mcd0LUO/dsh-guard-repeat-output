/**
 * W1511 corpus scan — run the shipped detector over every real session log.
 *
 * Streams `session.v3.jsonl.zstd` (decompressed by `zstd -dc`), pulls every
 * assistant `reasoning` / `text` block, and feeds each one through its own
 * RepetitionGuard. A block is the unit that matters: one assistant message is
 * one streamed model call, which is exactly what the plugin wraps.
 *
 * Reports, per session: how many blocks were degenerate, the worst evidence, and
 * how many characters a truncation would have saved.
 *
 * Usage: node scan-corpus.mjs <fileListFile> [--json <out>]
 *   fileListFile: one absolute session log path per line
 */
import { createReadStream } from 'node:fs'

import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync } from 'node:fs'
import { RepetitionGuard } from '../index.js'

const listFile = process.argv[2]
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null
const DELTA = 40

/** Feed one block through a fresh guard; return the first conviction. */
function judge(text, channel) {
  if (text.length < 1200) return null
  const guard = new RepetitionGuard()
  for (let i = 0; i < text.length; i += DELTA) {
    const evidence = guard.push(text.slice(i, i + DELTA), channel)
    if (evidence !== null) return { evidence, at: i + DELTA }
  }
  return null
}

/** Stream one session log; collect every degenerate model text block. */
function scanSession(path) {
  return new Promise(resolve => {
    const results = []
    // Read plain JSONL. Session logs live under /opt/dsh (root-only), so they are
    // decompressed to a readable staging directory first — spawning `sudo zstd`
    // here would fail silently and report a clean corpus that was never read.
    const input = createReadStream(path)
    const rl = createInterface({ input, crlfDelay: Infinity })

    rl.on('line', line => {
      // Cheap pre-filter before JSON.parse: most lines are not assistant messages.
      if (!line.includes('"assistant/message"')) return
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      if (event?.type !== 'assistant/message') return
      const content = event?.data?.message?.content
      if (!Array.isArray(content)) return
      for (const block of content) {
        if (block?.type !== 'reasoning' && block?.type !== 'text') continue
        const text = typeof block.text === 'string' ? block.text : ''
        if (text.length < 1200) continue
        const channel = block.type === 'reasoning' ? 'reasoning' : 'text'
        const hit = judge(text, channel)
        if (hit !== null) {
          results.push({
            channel,
            kind: hit.evidence.kind,
            at: hit.at,
            len: text.length,
            saved: text.length - hit.at,
            topPhrase: hit.evidence.topPhrase,
            topPhraseCount: hit.evidence.topPhraseCount,
            longestRun: hit.evidence.longestRun,
            segments: hit.evidence.segments,
            duplicateShare: Number(hit.evidence.duplicateShare.toFixed(4)),
            uniqueGramRatio: Number(hit.evidence.uniqueGramRatio.toFixed(4)),
            turn: event?.data?.turn,
            step: event?.data?.step,
            time: event?.time,
          })
        }
      }
    })

    const finish = () => resolve(results)
    rl.on('close', finish)
    rl.on('error', finish)
    input.on('error', finish)
  })
}

const files = readFileSync(listFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
let done = 0
let totalHits = 0
let totalBlocks = 0
const sessions = []

const CONCURRENCY = 8
let cursor = 0
async function worker() {
  while (cursor < files.length) {
    const path = files[cursor]
    cursor += 1
    let hits = []
    try {
      hits = await scanSession(path)
    } catch {
      hits = []
    }
    done += 1
    if (hits.length > 0) {
      totalHits += hits.length
      sessions.push({ path, hits })
      const worst = hits.reduce((a, b) => (b.saved > a.saved ? b : a))
      console.log(`HIT  ${path}`)
      console.log(`     ${hits.length} degenerate block(s); worst: ${worst.channel} `
        + `len=${worst.len} at=${worst.at} saved=${worst.saved} `
        + `phrase="${worst.topPhrase.slice(0, 50)}" x${worst.topPhraseCount} run=${worst.longestRun}`)
    }
    if (done % 100 === 0) process.stderr.write(`  ...${done}/${files.length} sessions, ${totalHits} hits\n`)
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))

console.log(`\n=== SCAN SUMMARY ===`)
console.log(`  sessions scanned      : ${files.length}`)
console.log(`  sessions with collapse: ${sessions.length}`)
console.log(`  degenerate blocks     : ${totalHits}`)
const saved = sessions.flatMap(s => s.hits).reduce((a, h) => a + h.saved, 0)
console.log(`  chars a truncation would have saved : ${saved.toLocaleString()}`)
if (jsonOut !== null) writeFileSync(jsonOut, JSON.stringify({ files: files.length, sessions }, null, 1))
