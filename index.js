/**
 * dsh-guard-repeat-output — Host-side degenerate-repetition guard for streaming
 * model output.
 *
 * ## The failure this exists for
 *
 * A DeepSeek-family model generating a long reply can collapse into emitting the
 * same phrase thousands of times in a row. Two real incidents motivated this
 * guard:
 *
 *   | length      | shape                                                   |
 *   |-------------|---------------------------------------------------------|
 *   | 1,371,962 c | "let me produce" x 27,269 — pure repetition              |
 *   |   250,506 c | "let me write" x1958 alternating with                    |
 *   |             | "let me write the call" x1951                            |
 *
 * Nothing in the loop noticed, so the turn burned tokens until the model stopped
 * by itself or a human pressed cancel.
 *
 * The first incident matters for the design: **all 142 degenerate parts were in
 * the `reasoning` channel while all 10 `text` parts of the same session were
 * healthy.** A text-only detector would not have fired once. `text` and
 * `reasoning` therefore get SEPARATE windows and are judged independently —
 * reasoning is naturally more repetitive than prose, and one shared window would
 * let a long healthy answer dilute a collapsing reasoning burst.
 *
 * ## Three steps
 *
 * 1. **Detect** — `llm/stream` is wrapped in an AsyncIterable that feeds every
 *    text/reasoning delta into an online, bounded detector.
 * 2. **Truncate** — on conviction the wrapper stops yielding and breaks out of
 *    the upstream iterator. `break` invokes the source's `return()`, so the
 *    adapter request is cancelled rather than merely ignored: the tokens are not
 *    generated in the first place. The healthy prefix has already been yielded.
 * 3. **Continue** — the agent is told to carry on from the truncation point via
 *    `agent.inject()`, which lands in the inbox's `next-step` list. The loop's
 *    `turn()` only closes while `inbox.nextStep` is empty, so this keeps the turn
 *    open for exactly one more step. `agent/pre-step` then guarantees the
 *    instruction is actually in the admitted messages, and tracks the per-turn
 *    truncation budget.
 *
 * ## Why stopping the stream is safe
 *
 * The agent loop reads the terminal reason from `AssistantStreamAttempt.finish`,
 * which is `BlockAssembler.finish` — documented as "Terminal reason, defaulting
 * to stop when the stream omitted one". A stream that ends without a `finish`
 * chunk is therefore a well-formed `stop`, not an error: the loop commits the
 * partial assistant message, finds no tool calls, and returns `completed`. The
 * truncation is expressed as an ordinary short answer, and the continuation is
 * an ordinary next step.
 *
 * ## Detection rule — two signals must BOTH hold
 *
 * The window is split on sentence terminators into segments; segments shorter
 * than `minSegmentChars` are noise and dropped.
 *
 *   1. **phrase leg** — longest run of byte-identical consecutive segments
 *      >= `phraseRun`, OR the most frequent segment occurs >= `phraseTopCount`.
 *   2. **low-information leg** — duplicate share of segments >= `lowInfoDupShare`
 *      AND the distinct character k-gram ratio <= `maxUniqueGramRatio`.
 *
 * Requiring both is what makes it safe. Either alone has a large legitimate
 * population: a report citing one command block twelve times is phrase-
 * repetitive, and 14 small functions that each `return null` score a 0.107
 * k-gram ratio. Only "very repetitive AND very little new information" separates
 * a collapse from merely verbose output.
 *
 * The phrase leg carries both branches on purpose. `phraseTopCount` does the
 * real work (it convicted 4/4 real samples); `phraseRun` is load-bearing for the
 * narrow shape where three phrases each repeat exactly 8 times — a run of 8 that
 * never reaches a top count of 10.
 *
 * ## Cost
 *
 * O(windowChars) time and memory per evaluation, and an evaluation runs only
 * every `evalEveryChars` characters. A 100 KB answer costs ~500 scans over a
 * constant-size buffer and never rescans the full text. Nothing is retained
 * beyond the window.
 *
 * ## Bounded blast radius
 *
 * A conviction costs at most `maxTruncationsPerTurn` continuations. The last
 * truncation in a turn is performed WITHOUT injecting a continuation, so the
 * turn ends on a truncated prefix instead of looping. Every conviction is
 * appended as one JSON line to `logPath` so a false positive can be diagnosed
 * after the fact rather than argued about.
 *
 * @module dsh-guard-repeat-output
 */

import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path'

/** Plugin id used by Loader diagnostics and stamped on the messages this plugin injects. */
export const name = 'guard-repeat-output'

/* ------------------------------------------------------------------ *
 * Portable path resolution
 *
 * Configured paths must work on every platform, so they are never
 * concatenated with a hard-coded '/' and never assumed to be Linux
 * absolute paths. The conventions mirror the harness's own home-paths
 * helper ($DSH_HOME, else ~/.dsh) but are implemented locally: this
 * plugin takes no host-package dependency, so it must not fail to load
 * on a host that does not expose one.
 * ------------------------------------------------------------------ */

/** The harness home: an explicit `$DSH_HOME`, else `~/.dsh` (harness convention). */
export function harnessHome(env = process.env) {
  const configured = env?.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return resolve(configured.trim())
  return join(homedir(), '.dsh')
}

/**
 * Expand one configured path to an absolute, platform-native path.
 *
 *   - `~`, `~/x`, `~\x`   -> the OS home directory
 *   - `$DSH_HOME`, `${DSH_HOME}` -> the harness home
 *   - a relative path      -> resolved under the harness home, so a config
 *                            can stay machine-independent
 *   - an absolute path     -> used as-is (every platform's own syntax)
 *
 * @param value - configured path, or null/empty to disable.
 * @returns an absolute path, or null when the input disables the feature.
 */
export function expandConfiguredPath(value) {
  if (typeof value !== 'string') return null
  let text = value.trim()
  if (text.length === 0) return null
  text = text
    .replace(/^\$\{DSH_HOME\}/, harnessHome())
    .replace(/^\$DSH_HOME(?=$|[\\/])/, harnessHome())
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  // Absolute in EITHER platform's convention is left alone. Checking only the
  // host's isAbsolute would silently rebase a Windows path under the harness
  // home when the config is read on Linux (and vice versa), turning an explicit
  // path into a surprising one. Pass it through and let the OS report clearly.
  if (isAbsolute(text) || win32.isAbsolute(text)) return text
  return join(harnessHome(), text)
}

/** Default tunables; the shipped patch sets these explicitly too. */
const DEFAULTS = Object.freeze({
  windowChars: 2400,
  minWindowChars: 1200,
  minSegments: 24,
  minSegmentChars: 12,
  phraseRun: 8,
  phraseTopCount: 10,
  lowInfoDupShare: 0.85,
  maxUniqueGramRatio: 0.3,
  /**
   * Consecutive non-repeated segments tolerated inside a degenerate run before
   * the onset walk declares it over. Guards the boundary against a stray unique
   * segment, while still stopping before healthy prose.
   */
  onsetGapSegments: 2,
  gramK: 5,
  evalEveryChars: 200,
  /**
   * How many characters of raw text are held back before being released
   * downstream. This is what makes the cut PRECISE: the detector can only
   * convict once enough repetition has accumulated, so the conviction point
   * always lags the true onset. Holding text back keeps the pre-conviction text
   * in hand, so the cut can land where the degeneration actually began instead
   * of where it became provable. 0 disables holdback (cut at the conviction
   * point — the pre-pruning behaviour).
   */
  holdbackChars: 4096,
  modelIncludes: Object.freeze(['deepseek']),
  /**
   * Channels the guard acts on. Everything else is observe-only: convictions
   * are still logged and copied, but the stream passes through untouched.
   *
   * `text` is deliberately NOT here. Across 1546 real sessions, 59 convictions
   * landed in `reasoning` and ZERO in `text`; meanwhile `text` is the only
   * channel the user reads, so cutting it has no evidence behind it and risks
   * truncating a genuine answer.
   */
  truncateChannels: Object.freeze(['reasoning']),
  /**
   * How many times a collapsed attempt may be DISCARDED and re-issued. The
   * attempt never becomes a message, so the context is untouched; the retry is
   * perturbed (see `perturbEfforts`) because an identical request tends to
   * reproduce the identical collapse. The perturbed effort is restored on the
   * next request, so the lowering lasts one attempt, not the session.
   * On exhaustion the guard stops cleanly and asks the model to wrap up rather
   * than failing the turn.
   */
  maxDegenerationRetries: 2,
  /**
   * Fallback reasoning-effort ladder, used ONLY when the adapter cannot be
   * queried for the exact model's declared efforts.
   *
   * Normally the ladder is derived from the adapter's own declaration (see
   * `resolveLadder`), so the guard can never propose a rung the model lacks.
   * A hard-coded ladder cannot know that, and proposing an undeclared rung
   * throws UNSUPPORTED_REASONING_EFFORT — turning a caught collapse into a dead
   * turn. This default is ordered strongest-first and deliberately omits
   * `medium`, which the observed DeepSeek adapter does not declare.
   *
   * Reasoning effort is used instead of temperature because the observed route
   * sets no temperature at all (adapter default, unknown), so any absolute
   * value could be LOWER than the default and deepen the loop — repetition is
   * typically a low-temperature failure. Lowering effort also directly shortens
   * the channel that collapses.
   */
  perturbEfforts: Object.freeze(['max', 'high', 'low', 'off']),
  /**
   * Directory for copies of collapsed text. A copy is the ONLY surviving record
   * of what was discarded — without it a false positive is unrecoverable and the
   * corpus cannot grow from live traffic. It is a plain sidecar: never read back
   * into any request, so it cannot pollute context. Null disables.
   */
  copyDir: null,
  /** Per-copy character cap; a whole discarded attempt can be very large. */
  copyMaxChars: 262144,
  truncate: true,
  continueOnTruncate: true,
  maxTruncationsPerTurn: 1,
  logPath: null,
})

/* ------------------------------------------------------------------ *
 * Pure detector
 * ------------------------------------------------------------------ */

/** Segment terminators: sentence punctuation of both scripts, plus newlines. */
const SEGMENT_BREAK = /[.!?\n;。！？；]+/

/** Everything that is not a letter or digit (CJK included); used for the k-gram ratio. */
const NON_WORD = /[^0-9a-z\u4e00-\u9fff]+/g

/** Lowercase and collapse whitespace so formatting cannot hide a repetition. */
function normalize(text) {
  return text.toLowerCase().replace(/\s+/g, ' ')
}

/**
 * The trailing `windowChars` of the RAW text — the whole bounded state.
 *
 * Bounding happens on raw text on purpose: segmentation runs on the raw window,
 * so newlines must still be present when it does. Collapsing whitespace first
 * would turn `\n` into a space and silently make the `\n` in {@link SEGMENT_BREAK}
 * dead — a reply that repeats one unpunctuated line would then collapse into a
 * single enormous segment and never reach `minSegments`.
 */
function rawWindowOf(text, thresholds) {
  return text.length <= thresholds.windowChars
    ? text
    : text.slice(text.length - thresholds.windowChars)
}

/**
 * Split a RAW window into usable segments, dropping sub-threshold noise.
 *
 * Each segment is normalized after splitting (not before), so segments that
 * differ only in case or internal spacing still compare equal.
 */
function segmentsOf(rawWindow, thresholds) {
  return rawWindow
    .split(SEGMENT_BREAK)
    .map(part => normalize(part).trim())
    .filter(part => part.length >= thresholds.minSegmentChars)
}

/** Longest run of consecutive identical segments. */
function longestRun(segments) {
  let best = 0
  let run = 0
  let previous = null
  for (const segment of segments) {
    run = segment === previous ? run + 1 : 1
    previous = segment
    if (run > best) best = run
  }
  return best
}

/** The segment-level statistics the phrase leg needs. */
function segmentStats(segments) {
  const counts = new Map()
  for (const segment of segments) counts.set(segment, (counts.get(segment) ?? 0) + 1)
  let topPhrase = ''
  let topPhraseCount = 0
  for (const [segment, count] of counts) {
    if (count > topPhraseCount) {
      topPhrase = segment
      topPhraseCount = count
    }
  }
  return {
    segments: segments.length,
    topPhrase,
    topPhraseCount,
    longestRun: longestRun(segments),
    duplicateShare: 1 - counts.size / segments.length,
  }
}

/**
 * Distinct character k-grams over all k-grams of the compacted window (1 = everything is new).
 *
 * Normalizes first: the window is raw text, and `NON_WORD` only keeps lowercase
 * letters, so an uppercase character would otherwise be deleted rather than
 * folded — shrinking the compacted text and inflating novelty.
 */
function uniqueGramRatio(window, thresholds) {
  const compact = normalize(window).replace(NON_WORD, '')
  const { gramK } = thresholds
  if (compact.length < gramK) return 1
  const seen = new Set()
  let total = 0
  for (let i = 0; i + gramK <= compact.length; i += 1) {
    seen.add(compact.slice(i, i + gramK))
    total += 1
  }
  return total === 0 ? 1 : seen.size / total
}

/** The phrase leg: an identical run, or one segment dominating the window. */
function phraseRepeated(stats, thresholds) {
  return stats.longestRun >= thresholds.phraseRun || stats.topPhraseCount >= thresholds.phraseTopCount
}

/**
 * Where does the trailing degenerate run begin inside `text`?
 *
 * The detector convicts only once enough repetition has accumulated, so the
 * conviction point always LAGS the true onset — measured on the frozen corpus,
 * the lag is typically 3000-3600 characters. Cutting at the conviction point
 * therefore leaves that much already-degenerate text in the context. This finds
 * the boundary instead: walk back from the end while the running duplicate share
 * of the suffix stays at or above the low-information threshold, and return the
 * offset where it breaks.
 *
 * Pure and bounded: called once per conviction over the holdback buffer
 * (`holdbackChars`), never on the per-delta path.
 *
 * Two conditions stop the walk, and BOTH are needed. The duplicate-share test
 * alone overshoots badly: while the repeated phrase dominates the tail, the
 * ratio stays above threshold for roughly `1/threshold - 1` further segments, so
 * a healthy prefix gets walked into and dropped. The consecutive-unique bound
 * pins the boundary where repetition actually starts, tolerating a stray unique
 * segment inside an otherwise degenerate run.
 *
 * @param text - the raw held text.
 * @param thresholds - resolved tunables.
 * @returns offset of the first character of the degenerate run; `text.length`
 *   when no degenerate run is found (nothing to prune).
 */
export function degenerationOnset(text, thresholds) {
  const segments = []
  // A fresh regex per call: a shared /g/ regex would carry `lastIndex` across
  // calls, which is exactly the kind of hidden state that breaks under reuse.
  const scan = /[^.!?\n;。！？；]+/g
  let match
  while ((match = scan.exec(text)) !== null) {
    const normalized = normalize(match[0]).trim()
    if (normalized.length < thresholds.minSegmentChars) continue
    segments.push({ start: match.index, text: normalized })
  }
  if (segments.length === 0) return text.length

  // Walk back from the end, tracking the vocabulary of the CURRENT run only.
  //
  // A global frequency count is the wrong instrument here: in a block that is
  // mostly degenerate, a phrase the healthy prefix used once also appears
  // thousands of times later, so the prefix's own segment scores as a "repeat"
  // and the walk runs straight through the healthy text. Judging each segment
  // against what the run itself has already said pins the boundary where
  // repetition actually starts.
  const vocabulary = new Set()
  const tolerance = thresholds.onsetGapSegments
  let uniqueRun = 0
  let onset = text.length
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i].text
    if (vocabulary.has(segment)) {
      uniqueRun = 0
      onset = segments[i].start
      continue
    }
    uniqueRun += 1
    // Healthy prose resumes: the repetition run starts after this point.
    if (uniqueRun > tolerance) break
    vocabulary.add(segment)
  }
  return onset
}

/**
 * Judge ONE window. Pure: same text in, same verdict out, no state.
 *
 * @param text - raw window text (normalization happens here).
 * @param thresholds - resolved tunables.
 * @param channel - which output channel this window belongs to.
 * @returns the evidence when the window is degenerate, otherwise `null`.
 */
export function evaluateRepetitionWindow(text, thresholds, channel = 'text') {
  const limits = thresholds ?? DEFAULTS
  const window = rawWindowOf(text, limits)
  if (window.length < limits.minWindowChars) return null
  const segments = segmentsOf(window, limits)
  if (segments.length < limits.minSegments) return null
  const stats = segmentStats(segments)
  const unique = uniqueGramRatio(window, limits)
  const phrase = phraseRepeated(stats, limits)
  const lowInformation = stats.duplicateShare >= limits.lowInfoDupShare
    && unique <= limits.maxUniqueGramRatio
  if (!phrase || !lowInformation) return null
  return {
    kind: stats.longestRun >= limits.phraseRun ? 'phrase' : 'low-information',
    channel,
    windowChars: window.length,
    segments: stats.segments,
    topPhrase: stats.topPhrase.slice(0, 120),
    topPhraseCount: stats.topPhraseCount,
    longestRun: stats.longestRun,
    duplicateShare: stats.duplicateShare,
    uniqueGramRatio: unique,
  }
}

/** Per-channel online state: one bounded buffer and one evaluation cadence. */
function newChannel() {
  return { buffer: '', sinceEval: 0, consumed: 0, convictionAt: null }
}

/**
 * The stateful online detector. `push` one delta at a time.
 *
 * `text` and `reasoning` deltas live in SEPARATE windows and are judged
 * independently, so neither channel can dilute the other's evidence. Each window
 * keeps only the trailing `windowChars` of normalized text and is judged once
 * per `evalEveryChars` characters, which bounds time and memory regardless of
 * how long the answer runs.
 */
export class RepetitionGuard {
  #channels = { text: newChannel(), reasoning: newChannel() }
  #convicted = null
  #thresholds

  constructor(thresholds) {
    this.#thresholds = thresholds ?? DEFAULTS
  }

  /**
   * Feed one streamed delta.
   *
   * The delta is consumed in slices that land evaluations on an ABSOLUTE
   * character grid (`evalEveryChars`, `2*evalEveryChars`, ...) rather than on
   * whatever boundary the caller happens to use. Accumulating a counter and
   * resetting it to zero discards the overshoot, so the evaluation points drift
   * with chunk size — and because the judgement is made over a fixed-size
   * window, the same text can then convict or not convict purely by accident of
   * chunking. Measured on a real 4832-char collapse: chunk 3 and chunk 7 missed
   * it entirely while chunk 40 convicted at 4800.
   *
   * Chunk size is decided by the provider's SSE framing, which this plugin does
   * not control, so the grid must be chunk-independent.
   *
   * @param delta - raw text of one `text-delta` or `reasoning-delta` chunk.
   * @param channel - the window this delta belongs to.
   * @returns the evidence the FIRST time it convicts, otherwise `null`.
   */
  push(delta, channel = 'text') {
    if (this.#convicted !== null) return null
    const state = this.#channels[channel] ?? (this.#channels[channel] = newChannel())
    const every = this.#thresholds.evalEveryChars
    let offset = 0
    while (offset < delta.length) {
      // Stop exactly on the next grid line so the remainder carries over.
      const take = Math.min(every - state.sinceEval, delta.length - offset)
      state.buffer += delta.slice(offset, offset + take)
      if (state.buffer.length > this.#thresholds.windowChars) {
        state.buffer = state.buffer.slice(state.buffer.length - this.#thresholds.windowChars)
      }
      state.sinceEval += take
      offset += take
      state.consumed += take
      if (state.sinceEval >= every) {
        state.sinceEval = 0
        this.#convicted = evaluateRepetitionWindow(state.buffer, this.#thresholds, channel)
        if (this.#convicted !== null) {
          // Absolute character position of the evaluation that convicted — a
          // grid point, so it is identical for every chunking of the same text.
          state.convictionAt = state.consumed
          return this.#convicted
        }
      }
    }
    return null
  }

  /** The conviction, once one happened. */
  get evidence() {
    return this.#convicted
  }

  /** Normalized characters currently retained in one channel's window. */
  retainedChars(channel = 'text') {
    return this.#channels[channel]?.buffer.length ?? 0
  }

  /**
   * Absolute character position of the evaluation that convicted, or `null`.
   *
   * This is the grid point where the judgement was made — as opposed to where
   * the caller's chunk happened to end — so it must be identical for every
   * chunking of the same text. That property is what makes detection
   * reproducible against a provider's arbitrary SSE framing.
   */
  convictionAt(channel = 'text') {
    return this.#channels[channel]?.convictionAt ?? null
  }
}

/* ------------------------------------------------------------------ *
 * Plugin plumbing
 * ------------------------------------------------------------------ */

/** The source kind stamped on messages this plugin injects. */
const SOURCE_PLUGIN = 'dsh-guard-repeat-output'

/**
 * Failure code used to terminate a collapsed attempt.
 *
 * Deliberately NOT one of the harness's `DEFAULT_RETRYABLE_CODES`
 * (`EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`): llm-retry only
 * claims a failure whose code it recognises, so an unknown code makes it call
 * `next()` and hand the decision to this plugin, which re-issues immediately
 * instead of sitting through an exponential backoff meant for provider outages.
 */
const DEGENERATION_CODE = 'DEGENERATE_REPETITION'

/** The text a chunk carries, or `''` for chunks that carry none. */
function textOfChunk(chunk) {
  return typeof chunk?.text === 'string' ? chunk.text : ''
}

/** Concatenated text of the still-held chunks, from `head`. */
function heldTextOf(pending, head) {
  let text = ''
  for (let i = head; i < pending.length; i += 1) text += textOfChunk(pending[i])
  return text
}

/**
 * Make one file name safe on every platform.
 *
 * Session and agent ids are producer-supplied, so they may contain characters
 * that are legal on one OS and not another. Windows forbids `< > : " / \ | ? *`
 * and trailing dots/spaces, and reserves device names (`CON`, `NUL`, `COM1`…).
 * Sanitizing here keeps the sidecar writable everywhere instead of failing
 * silently on one platform only.
 */
export function safeFileName(value) {
  let text = String(value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
  if (text.length === 0) text = 'unnamed'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(text)) text = `_${text}`
  return text
}

/**
 * Write a copy of collapsed text to the sidecar directory.
 *
 * Fire-and-forget and bounded: this is the only surviving record of what was
 * discarded, but it must never block the stream or grow without limit. The file
 * holds raw text with no header so it can be fed straight back to the detector
 * as corpus.
 */
async function writeCopy(dir, cap, name, text) {
  if (typeof dir !== 'string' || dir.length === 0 || text.length === 0) return null
  try {
    const module = await fs()
    if (module === null) return null
    await module.mkdir(dir, { recursive: true })
    // join() picks the platform separator, so a Windows 'C:\\logs' does not
    // become 'C:\\logs/name' and a trailing separator does not double up.
    const path = join(dir, safeFileName(name))
    await module.writeFile(path, text.length > cap ? text.slice(0, cap) : text)
    return path
  } catch {
    /* diagnostics, never a control path */
  }
  return null
}

/** Deep-freeze a freshly built message so it satisfies the immutable creation contract. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * Build one identified user message. Constructed by hand rather than through
 * `createUserMessage` so this plugin needs no import of the harness packages:
 * the message shape is plain data, and `crypto.randomUUID` is available in Node.
 *
 * Producer-owned `kind` (v4 session format, DSH 0.1.7-rc.2+): admission
 * (`assertV4RowAdmission` → `source()`) requires a nonempty kind that is NOT
 * the reserved word `'plugin'`. Runtime writes skip the v3→v4 disk-replay
 * migration, so the canonical `plugin:<name>` shape is written directly; it
 * still renders as plugin-produced context, not a human prompt.
 */
const SOURCE_KIND = `plugin:${SOURCE_PLUGIN}`

function createContinuationMessage(text, summary) {
  return deepFreeze({
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'notice', summary },
  })
}

/** Whether a message was produced by this plugin (accepts the legacy v3 shape too). */
function isOurs(message) {
  const source = message?.source
  return source?.kind === SOURCE_KIND
    || (source?.kind === 'plugin' && source.plugin === SOURCE_PLUGIN)
}

/** The instruction handed back to the model after a truncation. */
function continuationText(evidence) {
  const where = evidence.channel === 'reasoning' ? 'reasoning channel' : 'reply text'
  return `[${SOURCE_PLUGIN}] Your previous output collapsed into degenerate repetition `
    + `(the ${where} repeated "${evidence.topPhrase}" ${evidence.topPhraseCount} times) and was `
    + `truncated at the point the repetition began. The text before that point was kept. `
    + `Continue the task from exactly where the truncated output stopped. State each step once: `
    + `do not restate a phrase you have already emitted, and if you were re-deriving the same `
    + `conclusion, write it once and move on to the next action.`
}

/**
 * The instruction for the FINAL allowed truncation in a turn.
 *
 * Deliberately not a "continue": a model that has already collapsed repeatedly
 * will collapse again if pointed back at the same line of work. This closes the
 * turn with something useful — the user gets the conclusion instead of a silent
 * stop — and names the repetition so the model stops restating it.
 */
function wrapUpText(evidence, truncations) {
  const where = evidence.channel === 'reasoning' ? 'reasoning channel' : 'reply text'
  return `[${SOURCE_PLUGIN}] Output collapsed into degenerate repetition ${truncations} times in `
    + `this turn (the ${where} kept repeating "${evidence.topPhrase}"); the last occurrence was `
    + `truncated at the point it began. Do not resume the previous line of reasoning — it is what `
    + `keeps collapsing. Instead: state the conclusion or current state ONCE, concisely, in your `
    + `reply text, then end the turn. If work remains, name the single next action in one line `
    + `rather than re-deriving it.`
}

/** Lazily resolve `node:fs/promises`; logging is optional and must never break the guard. */
let fsModule
function fs() {
  fsModule ??= import('node:fs/promises').catch(() => null)
  return fsModule
}

/** Append one JSON record to the configured log. Failures are swallowed by design. */
export async function appendRecord(logPath, record) {
  if (typeof logPath !== 'string' || logPath.length === 0) return
  try {
    const module = await fs()
    if (module === null) return
    const line = `${JSON.stringify(record)}\n`
    try {
      // Fast path: the log directory normally already exists, and staying on
      // the single append keeps this off the critical path.
      await module.appendFile(logPath, line)
    } catch (error) {
      // `appendFile` never creates parents on any platform, so a fresh install
      // with no log directory yet would silently lose every record. Create the
      // parent and retry exactly once.
      if (error?.code !== 'ENOENT') throw error
      await module.mkdir(dirname(logPath), { recursive: true })
      await module.appendFile(logPath, line)
    }
  } catch {
    /* logging is diagnostics, never a control path */
  }
}

/** Resolve and validate plugin config. Misconfiguration fails loud at load. */
function resolveConfig(raw) {
  const input = raw ?? {}
  const resolved = { ...DEFAULTS, ...input }
  for (const key of ['windowChars', 'minWindowChars', 'minSegments', 'minSegmentChars',
    'phraseRun', 'phraseTopCount', 'gramK', 'evalEveryChars', 'maxTruncationsPerTurn']) {
    const value = resolved[key]
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name}: \`${key}\` must be a positive integer, got ${String(value)}`)
    }
  }
  for (const key of ['lowInfoDupShare', 'maxUniqueGramRatio']) {
    const value = resolved[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${name}: \`${key}\` must be a number in [0,1], got ${String(value)}`)
    }
  }
  // 0 is legal: it disables holdback and restores cut-at-conviction behaviour.
  if (!Number.isInteger(resolved.holdbackChars) || resolved.holdbackChars < 0) {
    throw new Error(`${name}: \`holdbackChars\` must be an integer >= 0, got ${String(resolved.holdbackChars)}`)
  }
  if (!Number.isInteger(resolved.maxDegenerationRetries) || resolved.maxDegenerationRetries < 0) {
    throw new Error(`${name}: \`maxDegenerationRetries\` must be an integer >= 0`)
  }
  for (const key of ['truncateChannels', 'perturbEfforts']) {
    if (!Array.isArray(resolved[key]) || resolved[key].some(v => typeof v !== 'string')) {
      throw new Error(`${name}: \`${key}\` must be an array of strings`)
    }
  }
  if (resolved.copyDir !== null && typeof resolved.copyDir !== 'string') {
    throw new Error(`${name}: \`copyDir\` must be a string or null`)
  }
  if (!Number.isInteger(resolved.copyMaxChars) || resolved.copyMaxChars < 1) {
    throw new Error(`${name}: \`copyMaxChars\` must be a positive integer`)
  }
  if (!Array.isArray(resolved.modelIncludes) || resolved.modelIncludes.some(p => typeof p !== 'string')) {
    throw new Error(`${name}: \`modelIncludes\` must be an array of strings`)
  }
  if (resolved.minWindowChars > resolved.windowChars) {
    throw new Error(`${name}: \`minWindowChars\` must not exceed \`windowChars\``)
  }
  // Paths are expanded once, here, so every consumer receives an absolute
  // platform-native path. A relative value is taken relative to the harness
  // home rather than the process CWD, which differs per launch on every OS.
  resolved.copyDir = expandConfiguredPath(resolved.copyDir)
  resolved.logPath = expandConfiguredPath(resolved.logPath)
  return resolved
}

/**
 * Install the guard.
 *
 * @param ctx - plugin context; both listeners are scoped to it and disposed with it.
 * @param config - optional tunables; see {@link DEFAULTS}.
 */
export function apply(ctx, config) {
  const thresholds = resolveConfig(config)
  const modelIncludes = thresholds.modelIncludes
    .map(pattern => pattern.trim().toLowerCase())
    .filter(pattern => pattern.length > 0)

  /** Per-agent detection state. Keyed by the Agent object, so disposal collects it. */
  const states = new WeakMap()

  function stateFor(agent) {
    let state = states.get(agent)
    if (state === undefined) {
      state = {
        turn: null,
        truncated: false,
        evidence: null,
        truncations: 0,
        /** Discard-and-retry attempts used in the current step. */
        retries: 0,
        /** Set when the next request should be perturbed. */
        perturb: false,
        /** Effort to return to once the perturbation series ends. */
        baseEffort: undefined,
        /** The effort this guard actually set, so recovery can tell whether the
         *  lowered value is still ours or was replaced by something else. */
        perturbedTo: undefined,
        /** Set while a perturbation is outstanding and must be undone. */
        restorePending: false,
        /** The turn at whose end the restore becomes due. Until that turn ends the
         *  lowered rung stands, so a long turn cannot thrash between rungs. */
        restoreTurn: undefined,
      }
      states.set(agent, state)
    }
    return state
  }

  /** Whether this channel is acted on, or merely observed. */
  function truncates(channel) {
    return thresholds.truncate === true && thresholds.truncateChannels.includes(channel)
  }

  /**
   * Is this model id in scope? The incident this guard exists for is
   * DeepSeek-family output, and a false positive on an unrelated provider is
   * worse than no detection, so the test fails CLOSED on an empty or unknown id.
   */
  function inScope(model) {
    if (modelIncludes.length === 0) return true
    const id = String(model ?? '').trim().toLowerCase()
    if (id.length === 0) return false
    return modelIncludes.some(pattern => id.includes(pattern))
  }

  /** Which detector window a chunk belongs to, or `null` for chunks carrying no text. */
  function channelOf(chunk) {
    if (chunk?.type === 'text-delta') return 'text'
    if (chunk?.type === 'reasoning-delta') return 'reasoning'
    return null
  }

  /**
   * Record one conviction as a JSON line. Fire-and-forget: diagnostics must
   * never become a control path, so failures are swallowed inside `appendRecord`
   * and the returned promise is deliberately not awaited — logging must not
   * block, or slow the stream it is observing.
   */
  function logConviction(state, evidence, options, agent, seenChars, startedAt, continuing, prunedChars, action = 'observed') {
    void appendRecord(thresholds.logPath, {
      time: new Date().toISOString(),
      event: 'repetition-detected',
      action,
      sessionId: String(options?.sessionId ?? agent.id),
      provider: options?.provider ?? null,
      model: options?.model ?? null,
      turn: state.turn,
      channel: evidence.channel,
      kind: evidence.kind,
      topPhrase: evidence.topPhrase,
      topPhraseCount: evidence.topPhraseCount,
      longestRun: evidence.longestRun,
      segments: evidence.segments,
      duplicateShare: Number(evidence.duplicateShare.toFixed(4)),
      uniqueGramRatio: Number(evidence.uniqueGramRatio.toFixed(4)),
      seenChars,
      prunedChars,
      elapsedMs: Date.now() - startedAt,
      continuing,
    })
  }

  /**
   * Persist a copy of the collapsed text, then record where it went.
   *
   * The copy is written first and the path appended to the log line after, so a
   * reader can always recover the text a conviction refers to.
   */
  function saveCopy(state, evidence, options, agent, text) {
    // ISO timestamps already contain ':' and '.'; both are stripped so the name
    // is portable, and writeCopy sanitizes whatever the ids contribute.
    const name = `${String(options?.sessionId ?? agent.id)}__t${state.turn ?? 0}__`
      + `${new Date().toISOString().replace(/[:.]/g, '-')}__${evidence.channel}.txt`
    return writeCopy(thresholds.copyDir, thresholds.copyMaxChars, name, text)
      .then(path => {
        if (path !== null) {
          void appendRecord(thresholds.logPath, {
            time: new Date().toISOString(),
            event: 'repetition-copy',
            copy: path,
            chars: text.length,
            sessionId: String(options?.sessionId ?? agent.id),
            turn: state.turn,
            channel: evidence.channel,
          })
        }
        return path
      })
      .catch(() => null)
  }

  /**
   * Wrap one model stream.
   *
   * Chunks are held in a bounded FIFO and released once enough newer text has
   * arrived to push them past `holdbackChars`. Holding text back is what makes
   * the cut precise: on conviction the text around the true onset is still in
   * hand, so only the healthy prefix is released and the degeneration is
   * dropped. Without holdback the cut could only land at the conviction point,
   * which lags the onset by thousands of characters.
   *
   * The hot path is allocation-light and await-free: one array with a head index
   * (no `shift()`), and the only O(n) work — the onset search — runs once, on
   * conviction, over the bounded holdback. Nothing here takes a lock, and no
   * await is introduced inside the loop, so a slow consumer or a stalled
   * upstream cannot deadlock the guard.
   */
  async function* guardStream(agent, source, options) {
    const state = stateFor(agent)
    const guard = new RepetitionGuard(thresholds)
    const startedAt = Date.now()
    // Observe mode never cuts, so it must not delay output either.
    const holdbackChars = thresholds.truncate === true ? thresholds.holdbackChars : 0

    /** Held chunks in arrival order; `head` is the first un-released index. */
    const pending = []
    let head = 0
    let heldText = 0
    let heldChannel = null
    let seenChars = 0
    /**
     * Everything this attempt has emitted, kept ONLY to write the sidecar copy.
     *
     * The held FIFO cannot serve this purpose: with `holdbackChars: 0` it is
     * released every chunk, so at conviction it holds just the convicting chunk
     * (40 chars observed) — useless as a record of what was discarded. Since v2
     * discards the WHOLE attempt, the whole attempt is the artifact worth
     * keeping. Capped so a pathological stream cannot grow memory without bound.
     */
    let attemptText = ''
    const attemptCap = thresholds.copyDir === null ? 0 : thresholds.copyMaxChars
    let truncated = false

    const textLength = chunk => (typeof chunk?.text === 'string' ? chunk.text.length : 0)

    /** Reclaim the released prefix once it dominates the array. */
    const compact = () => {
      if (head > 64 && head * 2 >= pending.length) {
        pending.splice(0, head)
        head = 0
      }
    }

    /** Release from the front until at most `holdbackChars` remain held. */
    const releaseExcess = () => {
      if (heldText <= holdbackChars) return null
      const out = []
      while (heldText > holdbackChars && head < pending.length) {
        const chunk = pending[head]
        head += 1
        heldText -= textLength(chunk)
        out.push(chunk)
      }
      compact()
      return out
    }

    /** Release everything still held, in order. */
    const releaseAll = () => {
      if (head >= pending.length) {
        pending.length = 0
        head = 0
        heldText = 0
        return null
      }
      const out = pending.slice(head)
      pending.length = 0
      head = 0
      heldText = 0
      return out
    }

    /**
     * Release only what precedes `onset`, splitting the chunk that straddles it.
     * Everything from `onset` on is the degeneration and is dropped.
     */
    const releaseUpTo = onset => {
      const out = []
      let consumed = 0
      while (head < pending.length) {
        const chunk = pending[head]
        const length = textLength(chunk)
        if (consumed + length <= onset) {
          head += 1
          heldText -= length
          consumed += length
          out.push(chunk)
          continue
        }
        const keep = onset - consumed
        if (keep > 0) out.push({ ...chunk, text: chunk.text.slice(0, keep) })
        break
      }
      // Drop the remainder: it is the degeneration itself.
      pending.length = 0
      head = 0
      heldText = 0
      return out
    }

    try {
      for await (const chunk of source) {
        const channel = channelOf(chunk)

        // A non-text chunk or a channel switch ends the held run. Text must not
        // be held across unrelated output, or the onset search would span it.
        if (heldText > 0 && (channel === null || channel !== heldChannel)) {
          const out = releaseAll()
          heldChannel = null
          if (out !== null) for (const held of out) yield held
        }

        if (channel === null) {
          yield chunk
          continue
        }

        heldChannel = channel
        const text = typeof chunk.text === 'string' ? chunk.text : ''
        seenChars += text.length
        if (attemptText.length < attemptCap) attemptText += text
        pending.push(chunk)
        heldText += text.length

        const evidence = guard.push(text, channel)

        // Observe-only for this channel: log it and let the stream through
        // untouched. `text` is observe-only by default because 59/59 natural
        // convictions in the 1546-session scan were in `reasoning` and ZERO were
        // in `text` — while `text` is the only channel the user actually reads,
        // so cutting it buys nothing and risks truncating a real answer.
        if (evidence === null || !truncates(evidence.channel)) {
          if (evidence !== null) {
            logConviction(state, evidence, options, agent, seenChars, startedAt, false, 0)
            void saveCopy(state, evidence, options, agent, attemptText)
          }
          const out = releaseExcess()
          if (out !== null) for (const released of out) yield released
          continue
        }

        // Conviction on a truncating channel.
        //
        // v2: TERMINATE the attempt instead of truncating it. Emitting a
        // terminal `error` finish makes the loop settle this attempt as
        // `assistant/attempt` — NOT `assistant/message` — so none of this text
        // ever enters the context, and `agent/request-error` re-issues the call.
        // v1 truncated in place, which left the already-yielded tail committed
        // to the log: 11 of 111 surviving blocks still convicted, every one of
        // them with the conviction point within 133 chars of the block end.
        const retriesLeft = state.retries < thresholds.maxDegenerationRetries

        if (retriesLeft) {
          state.retries += 1
          state.perturb = true
          logConviction(state, evidence, options, agent, seenChars, startedAt, false, 0, 'discard-and-retry')
          void saveCopy(state, evidence, options, agent, attemptText)
          truncated = true
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: `degenerate repetition in ${evidence.channel}: `
                  + `"${evidence.topPhrase}" repeated ${evidence.topPhraseCount} times`,
                code: DEGENERATION_CODE,
              },
            },
          }
          return
        }

        // Retry budget exhausted. Emitting another `error` would make the turn
        // fail with an LlmError, so fall back to the v1 shape: stop cleanly and
        // hand the turn a wrap-up, which ends it with something useful.
        let held = ''
        for (let i = head; i < pending.length; i += 1) held += textOfChunk(pending[i])
        const onset = held.length === 0 ? 0 : degenerationOnset(held, thresholds)
        const released = releaseUpTo(onset)
        for (const chunk of released) yield chunk
        const prunedChars = held.length - onset

        state.evidence = evidence
        state.truncated = true
        logConviction(state, evidence, options, agent, seenChars, startedAt, false, prunedChars, 'budget-exhausted')
        void saveCopy(state, evidence, options, agent, held.slice(onset))

        if (thresholds.continueOnTruncate === true) {
          agent.inject(createContinuationMessage(
            wrapUpText(evidence, state.retries + 1),
            `repetition collapse x${state.retries + 1} — retry budget exhausted, asked to wrap up`,
          ))
        }
        truncated = true
        break
      }

      // Stream ended without a conviction: release whatever is still held.
      const out = releaseAll()
      if (out !== null) for (const held of out) yield held
    } catch (error) {
      // Cancelling the upstream request during our own truncation must not turn
      // a deliberately shortened answer into a failed turn. A genuine stream
      // error, on the other hand, still propagates.
      if (!truncated) throw error
    }
  }

  ctx.on('llm/stream', (options, next) => {
    const agents = ctx.get('agents')
    const sessionId = options?.sessionId
    if (agents === undefined || sessionId === undefined) return next()
    const agent = agents.get(sessionId)
    if (agent === undefined || !inScope(options?.model)) return next()
    return guardStream(agent, next(), options)
  })

  /**
   * Re-issue a call that was terminated for degenerate repetition.
   *
   * The terminated attempt was settled as `assistant/attempt`, so it is not in
   * the context: re-issuing sends the SAME context minus the collapsed text,
   * which is precisely "as if the collapse never happened". Any other failure
   * (a genuine provider error) is delegated downstream untouched, so llm-retry's
   * backoff still governs it.
   */
  ctx.on('agent/request-error', async ({ agent, failure }, next) => {
    if (failure?.code !== DEGENERATION_CODE) return next()
    const state = stateFor(agent)
    // The budget was already spent when the attempt was terminated; a retry that
    // arrives with no budget must fall through rather than loop forever.
    if (state.retries === 0) return next()
    return { kind: 'retry' }
  })

  /**
   * The reasoning efforts the EXACT model advertises, or `null` when the
   * capability cannot be established.
   *
   * A hard-coded effort ladder is a trap: a model may declare only a subset of
   * the rungs (for example `high`/`low`/`max`/`off`, with no `medium`), so stepping
   * `high` down to an undeclared rung throws UNSUPPORTED_REASONING_EFFORT and
   * converts a caught collapse into a dead turn. Observed live: a turn carried a
   * `discard-and-retry` conviction immediately before such a failure. This is
   * why the perturbation ladder is DERIVED from the list returned here rather
   * than taken from configuration.
   *
   * Three outcomes, and the caller MUST tell them apart:
   *   - a non-empty id list -> perturb, but only onto one of these rungs;
   *   - `[]`  -> the adapter positively reports NO reasoning support, so setting
   *     any effort throws UNSUPPORTED_REASONING_EFFORT. Perturbation is skipped;
   *     treating this as "unknown" would reintroduce the dead turn;
   *   - `null` -> capability UNKNOWN (no `llm` service, no `resolveModelInfo`, or
   *     the query threw). Fails OPEN to the configured ladder: a query that
   *     cannot run must not silently disable perturbation altogether.
   */
  async function supportedEfforts(config) {
    const provider = config?.provider
    const model = config?.model
    if (typeof provider !== 'string' || typeof model !== 'string') return null
    try {
      const llm = ctx.get('llm')
      if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return null
      const info = await llm.resolveModelInfo(provider, model)
      const reasoning = info?.reasoning
      // Absent reasoning metadata is an authoritative "this model does not
      // reason", not an unknown: requesting an effort for it is an error.
      if (reasoning === undefined || reasoning === false) return []
      const efforts = reasoning.efforts
      if (!Array.isArray(efforts)) return []
      return efforts
        .map(effort => (typeof effort === 'string' ? effort : effort?.id))
        .filter(id => typeof id === 'string' && id.length > 0)
    } catch {
      // A failed query is genuinely unknown, so fall back to the configured ladder.
      return null
    }
  }

  /**
   * Semantic strength of the effort ids the adapters use, weakest first.
   *
   * The adapter's declared array order is NOT a strength order — the observed
   * DeepSeek adapter declares `[off, low, high, max]` while another may declare
   * them any way it likes — so "step down" must be computed from this rank, not
   * from array position.
   */
  const EFFORT_RANK = Object.freeze({ off: 0, minimal: 0, low: 1, medium: 2, high: 3, max: 4 })

  /**
   * Order adapter-declared efforts strongest-first, so stepping to the next
   * entry is a genuine step DOWN. An id with no known rank is kept but placed
   * last: it is adapter-declared and therefore safe to set, and any change
   * breaks the repetition loop.
   */
  function orderEfforts(efforts) {
    return [...efforts].sort((a, b) => (EFFORT_RANK[b] ?? -1) - (EFFORT_RANK[a] ?? -1))
  }

  /**
   * The perturbation ladder, strongest-first.
   *
   * Derived from the adapter's own declaration for the exact model, so the guard
   * cannot propose a rung the model does not offer — which would throw
   * UNSUPPORTED_REASONING_EFFORT and turn a caught collapse into a dead turn.
   * `perturbEfforts` is the fallback for when the capability cannot be queried.
   *
   * @param supported - adapter-declared ids, or null when unknown.
   */
  function resolveLadder(supported) {
    if (supported === null || supported.length === 0) return thresholds.perturbEfforts
    return orderEfforts(supported)
  }

  /**
   * Perturb a re-issued request, then put the route back.
   *
   * Fires on EVERY attempt (the loop calls `prepareRequest` at the top of its
   * retry loop), so the flag is consumed here and the perturbation applies to
   * the one attempt that follows a collapse.
   *
   * Recovery: a lowered effort is written into `request/header` and the header
   * is re-logged whenever the config CHANGES (reason `change`), after which
   * every later request derives from it. So a perturbation is NOT confined to
   * one attempt — without an explicit restore, the session stays on the lowered
   * rung for the rest of its life.
   *
   * The restore is therefore deferred to the TURN BOUNDARY, implemented by
   * comparing the turn number: within the collapsing turn the lowered rung
   * stands (so a long turn cannot thrash back to the effort that just
   * collapsed), and the first request of the next turn restores it. That is the
   * earliest moment the effort can change anyway — it is only settable from this
   * waterfall — so no separate turn-end hook is needed.
   */
  ctx.on('agent/request', ({ agent }, next) => {
    const state = stateFor(agent)
    return next().then(async config => {
      // No new collapse: restore, but only once the collapsing turn has ended.
      if (!state.perturb) {
        if (!state.restorePending) return config
        const dueTurn = state.restoreTurn
        if (dueTurn === undefined || (state.turn ?? 0) <= dueTurn) return config
        const base = state.baseEffort
        const lowered = state.perturbedTo
        state.restorePending = false
        state.baseEffort = undefined
        state.perturbedTo = undefined
        state.restoreTurn = undefined
        // Something else (a user, a model switch) replaced the lowered value:
        // that choice wins over the guard's memory of the pre-collapse effort.
        if (lowered !== undefined && String(config?.reasoningEffort ?? '') !== lowered) return config
        if (base === undefined || base === config?.reasoningEffort) return config
        return { ...config, reasoningEffort: base }
      }

      state.perturb = false
      const current = config?.reasoningEffort
      const supported = await supportedEfforts(config)
      // Known-and-empty means this model takes no effort at all: any value we
      // set would be rejected, so leave the route untouched.
      if (supported !== null && supported.length === 0) return config
      const ladder = resolveLadder(supported)
      const index = ladder.indexOf(String(current ?? ''))
      // Already at the bottom usable rung (or an effort this ladder does not
      // know): there is nothing to step down to. The route may still hold a
      // lowered value from an earlier perturbation, so leave recovery armed.
      if (index === -1 || index === ladder.length - 1) return config
      // Only the FIRST perturbation of a series records the base: a second
      // collapse steps down from the already-lowered value, and recovery must
      // still return to the true original.
      if (state.baseEffort === undefined) state.baseEffort = String(current)
      state.perturbedTo = ladder[index + 1]
      state.restorePending = true
      // The restore becomes due when this turn ends. `state.turn` is set by
      // `agent/pre-step`; a collapse always happens inside a turn, so it is set.
      state.restoreTurn = state.turn ?? undefined
      return { ...config, reasoningEffort: ladder[index + 1] }
    })
  })

  ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
    const state = stateFor(agent)
    state.turn = turn
    // A new step is a new request series: the retry budget is per step.
    state.retries = 0
    state.perturb = false

    // A human interjection is new context, so repetition across it is not a
    // collapse: hand the turn a fresh truncation budget.
    if (messages.some(message => message.source?.kind === 'user')) state.truncations = 0

    const decision = await next()

    if (!state.truncated) return decision
    const evidence = state.evidence
    state.truncated = false
    state.evidence = null
    if (decision.kind !== 'enter' || evidence === null) return decision

    // The injected instruction normally arrives with the claimed inbox batch.
    // This is the backstop that makes the continuation load-bearing rather than
    // best-effort: if anything cleared the inbox or another listener replaced
    // the messages, the step still enters with the instruction in front.
    if (decision.messages.some(isOurs)) return decision
    return {
      ...decision,
      messages: [
        createContinuationMessage(
          continuationText(evidence),
          `repetition collapse in ${evidence.channel} — continuation restored at pre-step`,
        ),
        ...decision.messages,
      ],
    }
  })
}
