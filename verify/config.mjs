// Configuration validation — the guard's first line of defence.
//
// A mis-typed scope must FAIL LOUDLY, not silently widen. The bug this file
// pins down: `modelIncludes` uses an empty array to mean "every model", so a
// non-empty list whose entries all normalize away (`['   ']`) used to be
// filtered to empty and thereby mean "every model" too — the exact opposite of
// the caller's intent, and the dangerous direction, because every threshold is
// calibrated on DeepSeek output only.
//
// Usage: node verify/config.mjs
import * as guard from '../index.js'

let failed = 0
function check(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
  if (!ok) failed += 1
}

/** Apply the plugin with `config`; return the thrown message or null. */
function applyWith(config) {
  const ctx = { on() {}, get: () => undefined, logger: { warn() {}, info() {} }, inject() {} }
  try {
    guard.apply(ctx, { logPath: null, copyDir: null, ...config })
    return null
  } catch (error) {
    return String(error.message ?? error)
  }
}

console.log('\n=== modelIncludes: a blank scope must not widen to every model ===')
{
  check('the default is accepted', applyWith({}) === null)
  check('a named pattern is accepted', applyWith({ modelIncludes: ['deepseek'] }) === null)

  // An empty array is a DELIBERATE "every model" and must keep working.
  check('an empty array is accepted (means every model)', applyWith({ modelIncludes: [] }) === null)

  // A non-empty list that normalizes to nothing is a mistake, not a request.
  const blank = applyWith({ modelIncludes: ['   '] })
  check('a single blank pattern is rejected', blank !== null, blank?.slice(0, 72))
  check('the error explains how to mean "every model"',
    typeof blank === 'string' && /empty array/i.test(blank), 'mentions the empty-array alternative')

  const manyBlank = applyWith({ modelIncludes: ['', '  ', '\t'] })
  check('several blank patterns are rejected', manyBlank !== null, manyBlank?.slice(0, 72))

  // A list that keeps at least one usable entry is fine; blanks are just dropped.
  check('a blank mixed with a real pattern is accepted',
    applyWith({ modelIncludes: ['  ', 'glm'] }) === null)

  check('a non-string entry is still rejected',
    applyWith({ modelIncludes: [42] }) !== null)
}

console.log('\n=== truncateChannels: an unmatched channel is conservative, not dangerous ===')
{
  check('a real channel is accepted', applyWith({ truncateChannels: ['reasoning'] }) === null)
  check('an empty list is accepted (observe only)', applyWith({ truncateChannels: [] }) === null)
  // Unlike modelIncludes this matches EXACTLY, so a blank entry simply never
  // matches — it disables truncation rather than enabling it everywhere.
  check('a blank channel is accepted (it matches nothing)',
    applyWith({ truncateChannels: ['   '] }) === null)
  check('a non-string entry is rejected', applyWith({ truncateChannels: [1] }) !== null)
}

console.log('\n=== numeric ranges ===')
{
  check('holdbackChars 0 is legal (disables holdback)', applyWith({ holdbackChars: 0 }) === null)
  check('a negative holdbackChars is rejected', applyWith({ holdbackChars: -1 }) !== null)
  check('maxDegenerationRetries 0 is legal (observe + truncate)',
    applyWith({ maxDegenerationRetries: 0 }) === null)
  check('garbageRatio above 1 is rejected', applyWith({ garbageRatio: 1.5 }) !== null)
  check('garbageRatio 0 is legal', applyWith({ garbageRatio: 0 }) === null)
  check('garbageRunChars 0 is rejected', applyWith({ garbageRunChars: 0 }) !== null)
  check('minWindowChars above windowChars is rejected',
    applyWith({ minWindowChars: 9999, windowChars: 100 }) !== null)
}

console.log('\n=== booleans ===')
{
  check('sanitizeGarbage must be boolean', applyWith({ sanitizeGarbage: 'yes' }) !== null)
  check('cleanupCommand must be boolean', applyWith({ cleanupCommand: 1 }) !== null)
  check('both false is accepted',
    applyWith({ sanitizeGarbage: false, cleanupCommand: false }) === null)
}

console.log(`\n=== SUMMARY ===\n  ${failed === 0 ? 'PASS' : 'FAIL'} — ${failed} failed check(s)`)
process.exit(failed === 0 ? 0 : 1)
