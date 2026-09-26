// Sanitization and retroactive cleanup — the two capabilities ported from the
// earlier degeneration-guard so that replacing it loses nothing.
//
// These run against the SHIPPED plugin, not a copy, so they exercise the same
// modules the guard loads at runtime.
//
// Usage: node verify/maintenance.mjs
import { sanitizeText, isSevereGarbage } from '../lib/sanitize.js'
import { reasoningVerdict, findDegenerateMessages, cleanupNote } from '../lib/cleanup.js'
import { DEFAULTS } from '../index.js'

let failed = 0
function check(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
  if (!ok) failed += 1
}

const thresholds = DEFAULTS

/* ------------------------------------------------------------------ *
 * Sanitization: exact, no statistical judgement
 * ------------------------------------------------------------------ */
console.log('\n=== SANITIZE: blacklisted code points are removed, not judged ===')
{
  const nul = sanitizeText('a\u0000\u0000\u0000b')
  check('NUL bytes are stripped', nul.text === 'ab', JSON.stringify(nul.text))
  check('the removal count is reported', nul.removed === 3, `removed=${nul.removed}`)
  check('the longest run is reported', nul.maxRun === 3, `maxRun=${nul.maxRun}`)

  const fffd = sanitizeText('hello\uFFFDworld')
  check('U+FFFD is stripped', fffd.text === 'helloworld', JSON.stringify(fffd.text))

  const zw = sanitizeText('a\u200bb\ufeffc')
  check('zero-width and BOM are stripped', zw.text === 'abc', JSON.stringify(zw.text))

  const lone = sanitizeText('x\uD800y')
  check('a lone surrogate is stripped', lone.text === 'xy', JSON.stringify(lone.text))

  // The allowed controls must survive: they carry structure.
  const keep = sanitizeText('a\tb\nc\rd')
  check('tab/newline/CR survive', keep.text === 'a\tb\nc\rd' && keep.removed === 0, JSON.stringify(keep.text))

  // A well-formed astral pair is ordinary text and must not be split.
  const pair = sanitizeText('a\u{1F600}b')
  check('a valid surrogate pair survives intact', pair.text === 'a\u{1F600}b' && pair.removed === 0, JSON.stringify(pair.text))

  const clean = sanitizeText('ordinary prose')
  check('clean text is untouched and reports nothing', clean.removed === 0 && clean.text === 'ordinary prose')
}

console.log('\n=== SANITIZE: only DENSE garbage is treated as collapse ===')
{
  // One stray replacement char is a decoding hiccup, not a collapse.
  const hiccup = sanitizeText('a'.repeat(500) + '\uFFFD')
  check('a single stray replacement char is NOT severe',
    isSevereGarbage(hiccup, 32, 0.5) === false,
    `removed=${hiccup.removed} ratio=${hiccup.ratio.toFixed(4)}`)

  // An unbroken run of NULs means the model is gone.
  const burst = sanitizeText('a' + '\u0000'.repeat(200))
  check('a long unbroken run IS severe',
    isSevereGarbage(burst, 32, 0.5) === true,
    `maxRun=${burst.maxRun}`)

  // A high share of garbage within one delta is also collapse.
  const dense = sanitizeText('\u0000'.repeat(10) + 'ab')
  check('a dense share IS severe',
    isSevereGarbage(dense, 32, 0.5) === true,
    `ratio=${dense.ratio.toFixed(4)}`)

  check('zero removals is never severe', isSevereGarbage(sanitizeText('ok'), 32, 0.5) === false)
}

/* ------------------------------------------------------------------ *
 * Cleanup: the offline scan must agree with the live detector
 * ------------------------------------------------------------------ */
console.log('\n=== CLEANUP: the scan reuses the live detector ===')
{
  const degenerate = 'let me write the call now. '.repeat(400)
  // Healthy text must be genuinely VARIED. Repeating one sentence 30 times is
  // itself repetitive, and the detector correctly convicts it — using that as a
  // "healthy" control tests the fixture, not the detector. This composes real
  // prose from rotating parts so every sentence differs.
  const SUBJ = ['the loader', 'a worker', 'the parser', 'each adapter', 'the guard', 'this profile']
  const VERB = ['rejects', 'accepts', 'records', 'forwards', 'defers', 'resolves']
  const OBJ = ['the malformed frame', 'an unknown field', 'every delta', 'the pending batch', 'a stale token', 'the nested envelope']
  const EXTRA = ['before writing', 'after the fold', 'once the lease expires', 'while the stream is open']
  const healthy = Array.from({ length: 80 }, (_, i) =>
    `${SUBJ[(i * 5 + 1) % SUBJ.length]} ${VERB[(i * 7 + 2) % VERB.length]} `
    + `${OBJ[(i * 11 + 3) % OBJ.length]} ${EXTRA[(i * 13 + 5) % EXTRA.length]} in cycle ${i * 37 + 11}.`,
  ).join(' ')

  const degVerdict = reasoningVerdict(degenerate, thresholds)
  check('a degenerate block is convicted by the scan', degVerdict !== null,
    degVerdict === null ? 'no verdict' : `kind=${degVerdict.kind} dup=${degVerdict.duplicateShare.toFixed(3)}`)

  const okVerdict = reasoningVerdict(healthy, thresholds)
  check('a healthy block is NOT convicted', okVerdict === null,
    okVerdict === null ? 'clean' : `false positive: ${JSON.stringify(okVerdict).slice(0, 60)}`)

  const events = [
    { type: 'assistant/message', seq: 5, data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: healthy }] } } },
    { type: 'assistant/message', seq: 9, data: { turn: 1, step: 2, message: { content: [{ type: 'reasoning', text: degenerate }] } } },
  ]
  const found = findDegenerateMessages(events, thresholds)
  check('the scan finds exactly the degenerate message', found.length === 1 && found[0].seq === 9,
    found.map(f => `seq=${f.seq}`).join(', ') || 'none')

  // SAFETY: a message owning tool calls must be flagged so the caller can skip it.
  const withTool = [
    { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { content: [
      { type: 'reasoning', text: degenerate },
      { type: 'tool-call', id: 'c1', name: 'read' },
    ] } } },
  ]
  const toolFound = findDegenerateMessages(withTool, thresholds)
  check('a degenerate message owning tool calls is flagged, not silently replaced',
    toolFound.length === 1 && toolFound[0].hasToolCall === true,
    `hasToolCall=${toolFound[0]?.hasToolCall}`)

  check('the cleanup note names the block and its measurements',
    /\d+ characters of repeating text at turn 1, step 2/.test(cleanupNote(found[0])),
    cleanupNote(found[0]).split('\n')[1])
}

console.log(`\n=== SUMMARY ===\n  ${failed === 0 ? 'PASS' : 'FAIL'} — ${failed} failed check(s)`)
process.exit(failed === 0 ? 0 : 1)
