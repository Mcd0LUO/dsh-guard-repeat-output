// Does lowering the reasoning effort actually PREVENT a repetition collapse?
//
// The guard's primary path is "discard the collapsed attempt and retry one rung
// down". The lowering is the part whose necessity is unproven, so this script
// measures it against real traffic instead of assuming it.
//
// The decisive question is not "did the retry succeed" — a retry is a fresh
// generation, so it can succeed for reasons unrelated to the effort. The
// question is whether the SAME session collapses AGAIN after being lowered. If
// it does, the lowered rung did not make the model immune, and the load-bearing
// part of the recovery was the discard, not the lowering.
//
// Usage: node effort-necessity.mjs <guardLogPath> <sessionsRoot>
//
// Both inputs are operational data and are NOT part of this package:
//   guardLogPath  — the JSONL the guard writes when logPath is configured
//   sessionsRoot  — a DSH sessions root containing <workspace>/session-*/session.v4.jsonl.zstd
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const [logPath, sessionsRoot] = process.argv.slice(2)
if (!logPath || !sessionsRoot) {
  console.error('usage: node effort-necessity.mjs <guardLogPath> <sessionsRoot>')
  process.exit(2)
}

/** Every session.v4 file under the sessions root. */
function findSessions(root) {
  const out = []
  for (const ws of readdirSync(root)) {
    const wsPath = join(root, ws)
    if (!statSync(wsPath).isDirectory()) continue
    for (const s of readdirSync(wsPath)) {
      const f = join(wsPath, s, 'session.v4.jsonl.zstd')
      if (existsSync(f)) out.push(f)
    }
  }
  return out
}

/** Decompress one session log into rows. */
function load(file) {
  const raw = execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 30 })
  const rows = []
  for (const line of raw.toString('utf8').split('\n')) {
    const t = line.trim()
    if (t.length === 0) continue
    try { rows.push(JSON.parse(t)) } catch { /* skip a torn line */ }
  }
  return rows
}

const effortOf = r => {
  const h = r.header ?? r.data?.header ?? {}
  return h.config?.reasoningEffort
}

// Index sessions by id so a conviction can find its log.
const byId = new Map()
for (const f of findSessions(sessionsRoot)) {
  const id = f.split('/').slice(-2)[0]
  byId.set(id, f)
}

const convictions = []
for (const line of readFileSync(logPath, 'utf8').split('\n')) {
  const t = line.trim()
  if (t.length === 0) continue
  let r
  try { r = JSON.parse(t) } catch { continue }
  if (r.event === 'repetition-detected') convictions.push(r)
}

/** For one conviction, the rung before and the first rung after, plus the outcome. */
function trace(d) {
  const file = byId.get(d.sessionId)
  if (!file) return null
  const rows = load(file)
  const ms = Date.parse(d.time)
  const at = rows.find(r => r.type === 'assistant/attempt' && Math.abs((r.time ?? 0) - ms) < 2000)
  if (!at) return null
  const seq = at.seq

  const before = rows.filter(r => r.type === 'request/header' && (r.seq ?? 0) < seq).map(effortOf)
  const afterH = rows.find(r => r.type === 'request/header' && (r.seq ?? 0) > seq)
  const afterM = rows.find(r => r.type === 'assistant/message' && (r.seq ?? 0) > seq)
  const afterEnd = rows.find(r => r.type === 'turn/end' && (r.seq ?? 0) > seq)

  const from = before.at(-1) ?? null
  const to = afterH ? effortOf(afterH) : from
  let outcome = 'unresolved'
  if (afterEnd && afterM && afterEnd.seq < afterM.seq) {
    const reason = afterEnd.data?.reason ?? {}
    outcome = reason.kind === 'error' ? `died:${reason.error?.code ?? 'ERROR'}` : `turn:${reason.kind}`
  } else if (afterM) {
    outcome = 'resolved'
  }
  // A later conviction in the SAME session means the lowered rung did not confer
  // immunity. That is the measurement this script exists for.
  const later = convictions.filter(c => c.sessionId === d.sessionId && c.time > d.time).length
  return { from, to, lowered: from !== to, outcome, later }
}

const traces = convictions.map(trace).filter(Boolean)
console.log(`convictions: ${traces.length}`)
console.log()

const lowered = traces.filter(t => t.lowered)
// A conviction with no new header is NOT "retried at the same rung". It is a
// lowering that the adapter REJECTED: the request never dispatched, so no header
// was written and the rung appears unchanged. Those are the dead turns.
const rejected = traces.filter(t => !t.lowered)
console.log(`lowered on retry   : ${lowered.length}  (resolved ${lowered.filter(t => t.outcome === 'resolved').length}, died ${lowered.filter(t => t.outcome.startsWith('died')).length})`)
console.log(`lowering rejected  : ${rejected.length}  (resolved ${rejected.filter(t => t.outcome === 'resolved').length}, died ${rejected.filter(t => t.outcome.startsWith('died')).length})`)
console.log()

const diedUnsupported = traces.filter(t => t.outcome.includes('UNSUPPORTED_REASONING_EFFORT'))
console.log(`died on an unsupported rung: ${diedUnsupported.length}`)
for (const t of diedUnsupported) console.log(`   ${t.from} -> (proposed)   outcome=${t.outcome}`)
console.log()

// The measurement that decides necessity. Lowering is only load-bearing if it
// confers immunity; if a session that was successfully lowered and resolved goes
// on to collapse AGAIN, then the discard-and-regenerate is doing the work and the
// lowering is not. (It is still worth keeping as a cheap perturbation — but the
// evidence must be read for what it is, not assumed.)
const resolvedLowered = lowered.filter(t => t.outcome === 'resolved')
const recurred = resolvedLowered.filter(t => t.later > 0)
console.log('sessions lowered and resolved, which then collapsed AGAIN later:')
console.log(`   ${recurred.length} of ${resolvedLowered.length}`)
if (resolvedLowered.length > 0) {
  const rate = (100 * recurred.length / resolvedLowered.length).toFixed(0)
  console.log(`   recurrence rate at the lowered rung: ${rate}%`)
}
