/**
 * W1511 mutation negative controls.
 *
 * Each control breaks ONE load-bearing property of the shipped plugin, proves the
 * corresponding check goes RED, restores the original source, and proves it goes
 * GREEN again. Mutations are applied to a real copy of `../index.js`, so the code
 * under test is always the shipped code path.
 *
 * Covered:
 *   1. channel isolation   (text and reasoning must not share a window)
 *   2. phrase leg          (phraseRun + phraseTopCount)
 *   3. low-information leg (duplicate share + k-gram ratio)
 *   4. truncation point    (healthy prefix kept, collapse not emitted)
 *
 * Every fixture below was measured against the shipped detector before being
 * used, so a control fails only for the reason it is meant to test.
 *
 * Usage: node mutations.mjs <corpusRoot>
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RepetitionGuard } from '../index.js'

const ROOT = process.argv[2] ?? '/tmp/w1510'
const ORIGINAL = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const DELTA = 40
const WORK = mkdtempSync(join(tmpdir(), 'w1511-mut-'))
let generation = 0

/**
 * The plugin's relative imports, made absolute.
 *
 * A variant is written to a temp directory, so `./lib/...` would resolve beside
 * the COPY and fail. Only `index.js` is mutated — the `lib/` modules are used
 * exactly as shipped — so the imports are rewritten to the real files.
 */
const LIB_IMPORTS = [
  [`'./lib/sanitize.js'`, `'${new URL('../lib/sanitize.js', import.meta.url).href}'`],
  [`'./lib/cleanup.js'`, `'${new URL('../lib/cleanup.js', import.meta.url).href}'`],
]

/** Load a (possibly mutated) copy of the plugin as a fresh module. */
async function loadVariant(source) {
  generation += 1
  const file = join(WORK, `index-${generation}.js`)
  let relocated = source
  for (const [from, to] of LIB_IMPORTS) relocated = relocated.split(from).join(to)
  writeFileSync(file, relocated)
  return import(`${pathToFileURL(file).href}?v=${generation}`)
}

/** Replace `from` with `to`, failing loudly if the anchor is gone. */
function mutate(source, from, to) {
  if (!source.includes(from)) throw new Error(`mutation anchor not found: ${from.slice(0, 60)}`)
  return source.replace(from, to)
}

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'CONTROL OK ' : 'CONTROL FAILED'}  ${name}  ${detail}`)
}

/* ------------------------------------------------------------------ *
 * Corpora
 * ------------------------------------------------------------------ */

const degenerate = readFileSync(`${ROOT}/unreg/deg1-seq2608.txt`, 'utf8')
const healthy = readFileSync(`${ROOT}/legit/L00000.txt`, 'utf8')
const healthy2 = readFileSync(`${ROOT}/legit/L00001.txt`, 'utf8')

/** Feed text as a delta stream on one channel; return where it convicted. */
function streamThrough(GuardClass, text, channel, thresholds) {
  const guard = new GuardClass(thresholds)
  let seen = 0
  for (let i = 0; i < text.length; i += DELTA) {
    const delta = text.slice(i, i + DELTA)
    seen += delta.length
    const evidence = guard.push(delta, channel)
    if (evidence !== null) return { evidence, at: seen }
  }
  return { evidence: null, at: null }
}

/**
 * Healthy prose interleaved 1:1 with a collapsing reasoning burst, matched so
 * that roughly equal VOLUMES of each channel enter the same stream. This is the
 * strongest dilution test: under a shared window the healthy prose occupies half
 * the buffer; with per-channel windows the reasoning buffer still fills with
 * nothing but the collapse.
 */
function mixedStream(GuardClass, thresholds) {
  const guard = new GuardClass(thresholds)
  const deltas = text => {
    const out = []
    for (let i = 0; i < text.length; i += DELTA) out.push(text.slice(i, i + DELTA))
    return out
  }
  const healthyDeltas = deltas(healthy.repeat(400))
  const degenerateDeltas = deltas(degenerate)
  const n = Math.min(healthyDeltas.length, degenerateDeltas.length)

  for (let i = 0; i < n; i += 1) {
    if (guard.push(healthyDeltas[i], 'text') !== null) return { hit: true, channel: 'text' }
    if (guard.push(degenerateDeltas[i], 'reasoning') !== null) return { hit: true, channel: 'reasoning' }
  }
  return { hit: false, channel: null }
}

/**
 * Three distinct phrases, each repeated exactly 8 times: the longest identical
 * run is 8 and the top-segment count is also 8, so `phraseTopCount` (10) can
 * never fire and only `phraseRun` can convict this shape.
 *
 * Segment length is tuned to 98 characters so the three phrases x8 fill the
 * window to exactly `windowChars` (2400). That keeps all 24 segments inside the
 * window at every evaluation — the evaluation cadence slices the window at
 * arbitrary offsets, so a fixture that only just clears `minSegments` can lose a
 * segment to a partial split and go dark for the wrong reason.
 */
function narrowRunCase() {
  const phrases = [
    'the first verification step has now completed successfully and reported no errors at all across every platform',
    'the second verification stage has also finished without error and looks healthy in every supported environment',
    'the third and final check has passed and reported no problems whatsoever on any of the tested configurations',
  ]
  return phrases.map(phrase => `${phrase.slice(0, 98)}. `.repeat(8)).join('')
}

/**
 * Repetitive but genuinely informative text: forty distinct sentences (every
 * segment unique) followed by one command cited twelve times. The phrase leg
 * fires (top count 12) while the low-information leg does not (duplicate share
 * 0.355, k-gram ratio 0.099) — so it is convicted if and only if the
 * low-information leg is disabled.
 */
function repetitiveButInformative() {
  const distinct = Array.from({ length: 40 }, (_, i) =>
    `Release ${i} required a manual rollback of the desktop client after the migration script corrupted the local index.`)
  return `${distinct.join(' ')} ${'We ran pnpm check:fast. '.repeat(12)}`
}

/* ------------------------------------------------------------------ *
 * Control 1 — channel isolation
 * ------------------------------------------------------------------ */

console.log('=== CONTROL 1: channel isolation ===')
{
  const baseline = mixedStream(RepetitionGuard)
  const baseOk = baseline.hit && baseline.channel === 'reasoning'
  console.log(`  shipped: equal-volume mix -> hit=${baseline.hit} channel=${baseline.channel}`)

  // Break it: both channels share the text buffer.
  const shared = await loadVariant(
    mutate(ORIGINAL, '#channels = { text: newChannel(), reasoning: newChannel() }',
      '#channels = { text: newChannel(), reasoning: null }')
      .replace('const state = this.#channels[channel] ?? (this.#channels[channel] = newChannel())',
        'const state = this.#channels.text'),
  )
  const sharedResult = mixedStream(shared.RepetitionGuard)
  console.log(`  mutated (shared window): equal-volume mix -> hit=${sharedResult.hit} `
    + `channel=${sharedResult.channel}`)

  const restored = await loadVariant(ORIGINAL)
  const restoredResult = mixedStream(restored.RepetitionGuard)
  console.log(`  restored: equal-volume mix -> hit=${restoredResult.hit} `
    + `channel=${restoredResult.channel}`)

  record('channel isolation',
    baseOk && !sharedResult.hit && restoredResult.hit && restoredResult.channel === 'reasoning',
    `shipped=HIT(reasoning), shared-window=MISS (healthy prose dilutes it), restored=HIT`)
}

/* ------------------------------------------------------------------ *
 * Control 2 — phrase leg
 * ------------------------------------------------------------------ */

console.log('\n=== CONTROL 2: phrase leg ===')
{
  const pure = streamThrough(RepetitionGuard, degenerate, 'reasoning')
  const narrow = streamThrough(RepetitionGuard, narrowRunCase(), 'text')
  const narrowHit = narrow.evidence !== null && narrow.evidence.kind === 'phrase'
  console.log(`  shipped: pure repetition -> hit=${pure.evidence !== null} run=${pure.evidence?.longestRun}`)
  console.log(`  shipped: 3 phrases x8 (top count 8 < 10) -> hit=${narrowHit} `
    + `run=${narrow.evidence?.longestRun} top=${narrow.evidence?.topPhraseCount}`)

  // Disable the whole phrase leg.
  const ANCHOR = 'return stats.longestRun >= thresholds.phraseRun || stats.topPhraseCount >= thresholds.phraseTopCount'
  const noPhrase = await loadVariant(mutate(ORIGINAL, ANCHOR, 'return false'))
  const pureBroken = streamThrough(noPhrase.RepetitionGuard, degenerate, 'reasoning')
  const narrowBroken = streamThrough(noPhrase.RepetitionGuard, narrowRunCase(), 'text')
  console.log(`  mutated (phrase leg off): pure repetition -> hit=${pureBroken.evidence !== null}; `
    + `3 phrases x8 -> hit=${narrowBroken.evidence !== null}`)

  // Disable only the run branch: the narrow shape must go dark while the
  // top-count branch keeps convicting ordinary repetition.
  const noRun = await loadVariant(mutate(ORIGINAL, ANCHOR, 'return stats.topPhraseCount >= thresholds.phraseTopCount'))
  const narrowNoRun = streamThrough(noRun.RepetitionGuard, narrowRunCase(), 'text')
  const pureNoRun = streamThrough(noRun.RepetitionGuard, degenerate, 'reasoning')
  console.log(`  mutated (phraseRun off): 3 phrases x8 -> hit=${narrowNoRun.evidence !== null}; `
    + `pure repetition -> hit=${pureNoRun.evidence !== null} (top-count branch survives)`)

  const restored = await loadVariant(ORIGINAL)
  const restoredOk = streamThrough(restored.RepetitionGuard, degenerate, 'reasoning').evidence !== null
    && streamThrough(restored.RepetitionGuard, narrowRunCase(), 'text').evidence !== null

  record('phrase leg',
    pure.evidence !== null && narrowHit && pureBroken.evidence === null
    && narrowBroken.evidence === null && narrowNoRun.evidence === null
    && pureNoRun.evidence !== null && restoredOk,
    'shipped=HIT both shapes, leg off=MISS, run branch is load-bearing for the top-count-8 shape, restored=HIT')
}

/* ------------------------------------------------------------------ *
 * Control 3 — low-information leg
 * ------------------------------------------------------------------ */

console.log('\n=== CONTROL 3: low-information leg ===')
{
  const fixture = repetitiveButInformative()
  const shippedFixture = streamThrough(RepetitionGuard, fixture, 'text')
  const shippedDegenerate = streamThrough(RepetitionGuard, degenerate, 'reasoning')
  console.log(`  shipped: repetitive-but-informative -> hit=${shippedFixture.evidence !== null} `
    + `(phrase leg fires, low-info leg does not)`)
  console.log(`  shipped: pure repetition -> hit=${shippedDegenerate.evidence !== null} `
    + `dup=${shippedDegenerate.evidence?.duplicateShare.toFixed(3)} `
    + `gram=${shippedDegenerate.evidence?.uniqueGramRatio.toFixed(3)}`)

  // Break it: accept every duplication/novelty profile.
  const noLowInfo = await loadVariant(mutate(
    ORIGINAL,
    'const lowInformation = stats.duplicateShare >= limits.lowInfoDupShare\n    && unique <= limits.maxUniqueGramRatio',
    'const lowInformation = true',
  ))
  const fixtureBroken = streamThrough(noLowInfo.RepetitionGuard, fixture, 'text')
  const degenerateBroken = streamThrough(noLowInfo.RepetitionGuard, degenerate, 'reasoning')
  console.log(`  mutated (low-info leg off): repetitive-but-informative -> hit=${fixtureBroken.evidence !== null} `
    + `(FALSE POSITIVE); pure repetition -> hit=${degenerateBroken.evidence !== null}`)

  const restored = await loadVariant(ORIGINAL)
  const restoredOk = streamThrough(restored.RepetitionGuard, fixture, 'text').evidence === null
    && streamThrough(restored.RepetitionGuard, degenerate, 'reasoning').evidence !== null

  record('low-information leg',
    shippedFixture.evidence === null && shippedDegenerate.evidence !== null
    && fixtureBroken.evidence !== null && degenerateBroken.evidence !== null && restoredOk,
    'shipped=clean on informative-repetitive, leg off=FALSE POSITIVE on it, restored=clean')
}

/* ------------------------------------------------------------------ *
 * Control 4 — truncation point
 * ------------------------------------------------------------------ */

console.log('\n=== CONTROL 4: truncation point ===')

/** Install the plugin against a fake ctx and capture its llm/stream listener. */
function install(module, config) {
  const listeners = new Map()
  const injected = []
  const agent = { id: 'session-mutation-test', inject: message => injected.push(message) }
  const ctx = {
    on: (event, listener) => listeners.set(event, listener),
    get: serviceName => (serviceName === 'agents' ? { get: () => agent } : undefined),
  }
  module.apply(ctx, config)
  return { listeners, injected }
}

/** Drive one synthetic chunk stream through the captured listener. */
async function drive(module, config, chunks) {
  const { listeners, injected } = install(module, config)
  let sourceClosed = false
  async function* source() {
    try {
      for (const chunk of chunks) yield chunk
    } finally {
      sourceClosed = true
    }
  }
  const stream = listeners.get('llm/stream')(
    { sessionId: 'session-mutation-test', provider: 'deepseek', model: 'deepseek-chat' },
    () => source(),
  )
  const yielded = []
  for await (const chunk of stream) yielded.push(chunk)
  return { yielded, injected, sourceClosed }
}

/** Split text into StreamChunks for one channel. */
function chunksOf(text, channel, index) {
  const type = channel === 'reasoning' ? 'reasoning-delta' : 'text-delta'
  const out = [{ type: 'block-start', index, blockType: channel === 'reasoning' ? 'reasoning' : 'text' }]
  for (let i = 0; i < text.length; i += DELTA) out.push({ type, index, text: text.slice(i, i + DELTA) })
  return out
}

const prefix = healthy2.slice(0, 6000)
const collapse = degenerate.slice(0, 60000)
const sourceText = prefix + collapse
const scenario = [...chunksOf(prefix, 'reasoning', 0), ...chunksOf(collapse, 'reasoning', 0)]

{
  const shipped = await drive(await loadVariant(ORIGINAL), { logPath: null, maxDegenerationRetries: 0 }, scenario)
  const text = shipped.yielded.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')

  const prefixKept = text.startsWith(prefix)
  const strictPrefix = sourceText.startsWith(text) && text.length < sourceText.length
  const cancelled = shipped.sourceClosed
  const injectedOk = shipped.injected.length === 1
    && shipped.injected[0].source.kind === 'plugin:dsh-guard-repeat-output'
    && shipped.injected[0].content[0].text.includes('degenerate repetition')
  // The detector must not be convicting the healthy prefix itself: the cut has
  // to land well past it, otherwise "truncation point" would be untested.
  const cutPastPrefix = text.length > prefix.length

  console.log(`  shipped: yielded ${text.length} of ${sourceText.length} chars `
    + `(healthy prefix ${prefix.length}); prefixKept=${prefixKept} strictPrefix=${strictPrefix} `
    + `cutPastPrefix=${cutPastPrefix} upstreamClosed=${cancelled} injected=${shipped.injected.length}`)

  // Break it: cut at the CONVICTION point instead of the onset — i.e. release the
  // whole holdback. The healthy prefix still survives and the result is still a
  // strict prefix, so only the "collapse must not be emitted" assertion catches
  // this, which is exactly the half that precision-pruning is responsible for.
  const lateCut = await loadVariant(mutate(
    ORIGINAL,
    'const onset = held.length === 0 ? 0 : degenerationOnset(held, thresholds)',
    'const onset = held.length',
  ))
  const late = await drive(lateCut, { logPath: null, maxDegenerationRetries: 0 }, scenario)
  const lateText = late.yielded.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
  const lateStillPrefix = sourceText.startsWith(lateText) && lateText.length < sourceText.length
  const leaked = lateText.length - text.length
  console.log(`  mutated (cut at conviction, not onset): yielded ${lateText.length} chars `
    + `(+${leaked} leaked); still-a-strict-prefix=${lateStillPrefix}`)

  // Break it differently: keep yielding after the conviction, so the collapse is
  // emitted in full and only the truncation assertion can catch it.
  const noTruncate = await drive(await loadVariant(ORIGINAL), { logPath: null, truncate: false }, scenario)
  const noTruncText = noTruncate.yielded.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
  console.log(`  mutated (truncate=false): yielded ${noTruncText.length} chars; `
    + `equals-source=${noTruncText === sourceText}`)

  const restored = await drive(await loadVariant(ORIGINAL), { logPath: null, maxDegenerationRetries: 0 }, scenario)
  const restoredText = restored.yielded.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')

  record('truncation point',
    prefixKept && strictPrefix && cutPastPrefix && cancelled && injectedOk
    && leaked > 0 && lateStillPrefix && noTruncText === sourceText
    && restoredText === text,
    `healthy prefix kept intact, collapse not emitted, upstream iterator closed, `
    + `exactly one continuation injected, restored identical`)
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

console.log('\n=== SUMMARY ===')
const passed = results.filter(r => r.ok).length
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`)
console.log(`  ${passed}/${results.length} controls passed`)
console.log(`  shipped source sha256: ${createHash('sha256').update(ORIGINAL).digest('hex')}`)
process.exitCode = passed === results.length ? 0 : 1
