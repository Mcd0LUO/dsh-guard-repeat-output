/**
 * W1511 conviction audit — show the exact window that convicted.
 *
 * Re-runs the shipped detector over every large block in one session and prints
 * the 2400-char window that tripped it, so a human can confirm the text really
 * is degenerate instead of trusting the metric alone. This is the check that
 * separates a genuine collapse from a threshold artefact.
 *
 * Usage: node audit-hits.mjs <plainJsonlSession> [--window] [--max N]
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { RepetitionGuard } from '../index.js'

const path = process.argv[2]
const showWindow = process.argv.includes('--window')
const maxArg = process.argv.indexOf('--max')
const maxShow = maxArg === -1 ? 3 : Number(process.argv[maxArg + 1])
const DELTA = 40

/** Feed a block through a fresh guard and capture the convicting window. */
function judge(text, channel) {
  const guard = new RepetitionGuard()
  let window = ''
  for (let i = 0; i < text.length; i += DELTA) {
    const delta = text.slice(i, i + DELTA)
    window += delta
    if (window.length > 2400) window = window.slice(window.length - 2400)
    const evidence = guard.push(delta, channel)
    if (evidence !== null) return { evidence, at: i + DELTA, window }
  }
  return null
}

const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
let blocks = 0
let convicted = 0
for await (const line of rl) {
  if (!line.includes('"assistant/message"')) continue
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  if (event?.type !== 'assistant/message') continue
  for (const block of event?.data?.message?.content ?? []) {
    if (block?.type !== 'reasoning' && block?.type !== 'text') continue
    const text = typeof block.text === 'string' ? block.text : ''
    if (text.length < 1200) continue
    blocks += 1
    const channel = block.type === 'reasoning' ? 'reasoning' : 'text'
    const hit = judge(text, channel)
    if (hit === null) continue
    convicted += 1
    const e = hit.evidence
    console.log(`\n=== CONVICTED block len=${text.length} channel=${channel} turn=${event?.data?.turn} step=${event?.data?.step}`)
    console.log(`at=${hit.at} kind=${e.kind} top="${e.topPhrase.slice(0, 70)}" x${e.topPhraseCount} run=${e.longestRun} segs=${e.segments} dup=${e.duplicateShare.toFixed(3)} gram=${e.uniqueGramRatio.toFixed(3)}`)
    if (showWindow && convicted <= maxShow) {
      console.log(`--- convicting window ---`)
      console.log(hit.window)
      console.log('--- end ---')
    }
  }
}
console.log(`\n${path.split('/').pop()}: judged=${blocks} convicted=${convicted}`)
