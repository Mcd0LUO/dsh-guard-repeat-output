// Garbage-token filtering — the "logits processor" layer of the defence.
//
// A plugin cannot touch logits, but it CAN sit on the chunk boundary, which is
// the same place in the pipeline one step later. A model that is half-collapsed
// emits garbage before it emits loops: NUL bytes, C0/C1 control codes, U+FFFD
// replacement characters (a decoding failure made visible), lone surrogates, and
// zero-width filler. None of that is ever legitimate in a reply, and unlike
// repetition it needs no statistical judgement — a blacklist decides it exactly.
//
//   strip   Remove blacklisted characters from a delta before it is forwarded,
//           so they never reach the session log. Always safe: these code points
//           carry no meaning in model output.
//   severe  Report a delta as evidence of collapse when the garbage is dense (a
//           long unbroken run, or a high share of the delta). The stream guard
//           then treats it like a detected loop: cut and stop.
//
// The distinction matters: one stray U+FFFD in a long answer is a decoding
// hiccup and should be cleaned silently; 200 NUL bytes in a row means the model
// is gone and the attempt should end.

/** Control characters that are legitimate in model output. */
const ALLOWED_CONTROLS = new Set([0x09, 0x0a, 0x0d]) // tab, newline, carriage return

/** Zero-width and byte-order code points that are never meaningful in a reply. */
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff, 0x2060])

/** U+FFFD REPLACEMENT CHARACTER: a decoder failure rendered as text. */
const REPLACEMENT = 0xfffd

/**
 * Classify one UTF-16 code unit.
 * @param {number} code - UTF-16 code unit.
 * @returns {'ok'|'control'|'replacement'|'zero-width'|'lone-surrogate'} the class.
 */
function classify(code) {
  if (code === REPLACEMENT) return 'replacement'
  if (ZERO_WIDTH.has(code)) return 'zero-width'
  // Lone surrogates: a well-formed pair is handled by the caller, so any
  // surrogate reaching here is unpaired and therefore malformed text.
  if (code >= 0xd800 && code <= 0xdfff) return 'lone-surrogate'
  // C0 (except the allowed three), DEL, and C1.
  if (code < 0x20 && !ALLOWED_CONTROLS.has(code)) return 'control'
  if (code === 0x7f) return 'control'
  if (code >= 0x80 && code <= 0x9f) return 'control'
  return 'ok'
}

/**
 * Remove blacklisted characters and measure how much garbage the text carried.
 *
 * @param {string} text - one delta or accumulated block text.
 * @returns {{text: string, removed: number, maxRun: number, ratio: number}}
 *   the cleaned text, the number of removed code units, the longest unbroken
 *   garbage run, and the removed fraction of the input.
 */
export function sanitizeText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: '', removed: 0, maxRun: 0, ratio: 0 }
  }
  let out = ''
  let removed = 0
  let run = 0
  let maxRun = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // A valid surrogate pair is ordinary text; skip both units together.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1]
        i++
        run = 0
        continue
      }
    }
    if (classify(code) === 'ok') {
      out += text[i]
      run = 0
      continue
    }
    removed++
    run++
    if (run > maxRun) maxRun = run
  }
  return { text: out, removed, maxRun, ratio: removed / text.length }
}

/**
 * Whether a sanitize result is dense enough to count as model collapse.
 *
 * Two independent triggers, both configurable:
 *   - an unbroken garbage run of `maxRun` or more code units, or
 *   - a garbage share of `maxRatio` or more within one delta.
 *
 * Both are far above anything legitimate output produces: a normal reply's
 * garbage count is zero, and a single decoding hiccup is one or two code units.
 *
 * @param {{removed: number, maxRun: number, ratio: number}} result - from {@link sanitizeText}.
 * @param {number} maxRun - unbroken-run length that means collapse.
 * @param {number} maxRatio - garbage fraction that means collapse.
 * @returns {boolean} true when the delta shows collapse.
 */
export function isSevereGarbage(result, maxRun, maxRatio) {
  if (result.removed === 0) return false
  return result.maxRun >= maxRun || result.ratio >= maxRatio
}
