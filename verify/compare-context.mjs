/**
 * W1511 context comparison — degenerate vs normal sessions.
 *
 * Hypothesis under test: degeneration is induced by the CONTEXT rather than by
 * the model sampling at random. This script measures nine context-shape
 * dimensions on both groups and reports distributions (median + quartiles, not
 * means — these are long-tailed).
 *
 * READ-ONLY over session logs. Nothing here modifies a session.
 *
 * Session logs live under /opt/dsh (root-only), so each is read through
 * `sudo -n zstd -dc`.
 *
 * Usage: node compare-context.mjs <corpusIndex> <allSessionsList> <outJson>
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const corpusIndex = process.argv[2] ?? '../corpus/index.json'
const allList = process.argv[3] ?? '/tmp/w1511-all-sessions.txt'
const outJson = process.argv[4] ?? '/tmp/w1511-ctx.json'

const index = JSON.parse(readFileSync(corpusIndex, 'utf8'))

/** workspace token for a session path: third component from the end, normalized. */
function workspaceOf(p) {
  const parts = p.split('/')
  const dir = parts[parts.length - 3] ?? ''
  const stripped = dir.replace(/^-+/, '').replace(/-+$/, '')
  return stripped.length > 0 ? stripped : 'root'
}

const sessionOf = p => p.split('/')[p.split('/').length - 2]

/** The 25 sessions that produced a degenerate block. */
const degenerate = new Map()
for (const e of index.entries) {
  const set = degenerate.get(e.session) ?? new Set()
  set.add(e.workspace)
  degenerate.set(e.session, set)
}

const all = readFileSync(allList, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)

/** Control pool: same workspaces as the degenerate set, minus the degenerate sessions. */
const degWorkspaces = new Set([...degenerate.values()].flatMap(s => [...s]))
const pool = all.filter(p => degWorkspaces.has(workspaceOf(p))
  && !degenerate.has(sessionOf(p).replace(/^session-/, ''))
  && !degenerate.has(sessionOf(p)))

/**
 * Deterministic sample: sort by path and take an even spread, so the control set
 * is reproducible and not biased toward whichever files happen to be newest.
 */
function sampleEvenly(list, n) {
  if (list.length <= n) return [...list]
  const step = list.length / n
  const out = []
  for (let i = 0; i < n; i += 1) out.push(list[Math.floor(i * step)])
  return out
}

const CONTROLS = 30
const controls = sampleEvenly([...pool].sort(), CONTROLS)

/** Sessions to measure: the degenerate ones that still exist, plus the controls. */
const degPaths = all.filter(p => degenerate.has(sessionOf(p).replace(/^session-/, ''))
  || degenerate.has(sessionOf(p)))

console.log(`degenerate sessions : ${degPaths.length}`)
console.log(`control pool        : ${pool.length} (workspaces: ${[...degWorkspaces].join(', ')})`)
console.log(`control sample      : ${controls.length}\n`)

/** Read one session log decompressed. */
function readLog(path) {
  try {
    return execFileSync('sudo', ['-n', 'zstd', '-dc', path], {
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('utf8')
  } catch {
    return null
  }
}

/** Compute every dimension for one session. */
function measure(path) {
  const text = readLog(path)
  if (text === null) return null
  const m = {
    session: sessionOf(path).replace(/^session-/, ''),
    workspace: workspaceOf(path),
    lines: 0,
    attempts: 0,
    retries: 0,
    compactionStart: 0,
    compactionPrune: 0,
    firstCompactionTurn: null,
    toolResults: 0,
    toolResultBytes: 0,
    assistantMessages: 0,
    assistantBytes: 0,
    userMessages: 0,
    steps: 0,
    turns: 0,
    toolCalls: 0,
    ptcDispatch: 0,
    inboxSpliced: 0,
    reasoningEffort: null,
    model: null,
    maxTokens: null,
    systemPromptChars: 0,
    toolsSchemaBytes: 0,
    /** Degenerate blocks in this session, with the turn/step they occurred at. */
    degenerateBlocks: [],
  }
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    m.lines += 1
    // Cheap pre-filter: the type token appears in every event line.
    let type = null
    const match = /^\{"type":"([^"]+)"/.exec(line)
    if (match !== null) type = match[1]
    else {
      try { type = JSON.parse(line).type } catch { continue }
    }
    switch (type) {
      case 'assistant/attempt': m.attempts += 1; break
      case 'llm/retry': m.retries += 1; break
      case 'compaction/start':
        m.compactionStart += 1
        if (m.firstCompactionTurn === null) {
          try { m.firstCompactionTurn = JSON.parse(line).data?.turn ?? null } catch { /* ignore */ }
        }
        break
      case 'compaction/prune': m.compactionPrune += 1; break
      case 'tool/result': {
        m.toolResults += 1
        m.toolResultBytes += line.length
        break
      }
      case 'assistant/message': {
        m.assistantMessages += 1
        m.assistantBytes += line.length
        break
      }
      case 'user/message': m.userMessages += 1; break
      case 'step/start': m.steps += 1; break
      case 'turn/start': m.turns += 1; break
      case 'tool/call': m.toolCalls += 1; break
      case 'tool/ptc-dispatch': m.ptcDispatch += 1; break
      case 'agent/inbox/spliced': m.inboxSpliced += 1; break
      case 'request/header': {
        try {
          const e = JSON.parse(line)
          const c = e.data?.header?.config ?? {}
          if (m.model === null) {
            m.model = c.model ?? null
            m.reasoningEffort = c.reasoningEffort ?? null
            m.maxTokens = c.maxTokens ?? null
          }
          const tools = e.data?.header?.tools
          if (Array.isArray(tools) && m.toolsSchemaBytes === 0) {
            m.toolsSchemaBytes = JSON.stringify(tools).length
          }
        } catch { /* ignore */ }
        break
      }
      case 'system/message': {
        try {
          const e = JSON.parse(line)
          const content = e.data?.message?.content ?? []
          const chars = content.reduce((a, b) => a + (typeof b.text === 'string' ? b.text.length : 0), 0)
          m.systemPromptChars = Math.max(m.systemPromptChars, chars)
        } catch { /* ignore */ }
        break
      }
      default: break
    }
  }
  return m
}

/** Median and quartiles of a numeric list. */
function stats(values) {
  const v = values.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0) return null
  const q = p => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))]
  return { n: v.length, min: v[0], q1: q(0.25), median: q(0.5), q3: q(0.75), max: v[v.length - 1] }
}

console.log('measuring degenerate sessions...')
const degMeasured = []
for (const p of degPaths) {
  const m = measure(p)
  if (m !== null) degMeasured.push(m)
  process.stderr.write('.')
}
console.log(`\nmeasuring controls...`)
const ctlMeasured = []
for (const p of controls) {
  const m = measure(p)
  if (m !== null) ctlMeasured.push(m)
  process.stderr.write('.')
}
console.log('')

const DIMENSIONS = [
  ['assistant/attempt 数', s => s.attempts],
  ['llm/retry 数', s => s.retries],
  ['compaction/start 数', s => s.compactionStart],
  ['compaction/prune 数', s => s.compactionPrune],
  ['tool/result 数', s => s.toolResults],
  ['tool/result 总字节', s => s.toolResultBytes],
  ['assistant/message 数', s => s.assistantMessages],
  ['assistant/message 总字节', s => s.assistantBytes],
  ['user/message 数', s => s.userMessages],
  ['step/start 数', s => s.steps],
  ['turn/start 数', s => s.turns],
  ['每 turn 平均 step', s => (s.turns > 0 ? s.steps / s.turns : 0)],
  ['tool/call 数', s => s.toolCalls],
  ['tool/ptc-dispatch 数', s => s.ptcDispatch],
  ['agent/inbox/spliced 数', s => s.inboxSpliced],
  ['system prompt 字符', s => s.systemPromptChars],
  ['tools schema 字节', s => s.toolsSchemaBytes],
  ['总行数', s => s.lines],
]

console.log('\n=== 维度对比（退化组 vs 对照组）===')
console.log(`${'维度'.padEnd(26)} ${'退化组 中位数'.padStart(14)} ${'对照组 中位数'.padStart(14)} ${'倍数'.padStart(8)}`)
const table = []
for (const [label, pick] of DIMENSIONS) {
  const a = stats(degMeasured.map(pick))
  const b = stats(ctlMeasured.map(pick))
  const ratio = b !== null && b.median > 0 && a !== null ? a.median / b.median : null
  table.push({ label, degenerate: a, control: b, ratio })
  const fmt = s => (s === null ? 'n/a' : String(s.median))
  console.log(`${label.padEnd(26)} ${fmt(a).padStart(14)} ${fmt(b).padStart(14)} `
    + `${(ratio === null ? 'n/a' : ratio.toFixed(2) + 'x').padStart(8)}`)
}

console.log('\n=== 模型配置 ===')
const cfg = s => `${s.model ?? '?'} / effort=${s.reasoningEffort ?? '?'} / maxTokens=${s.maxTokens ?? '?'}`
const tally = list => {
  const c = new Map()
  for (const s of list) c.set(cfg(s), (c.get(cfg(s)) ?? 0) + 1)
  return [...c.entries()].sort((a, b) => b[1] - a[1])
}
console.log('  退化组:', tally(degMeasured).map(([k, n]) => `${k} (${n})`).join('  |  '))
console.log('  对照组:', tally(ctlMeasured).map(([k, n]) => `${k} (${n})`).join('  |  '))

console.log('\n=== 压缩假设：退化是否发生在 compaction 之后 ===')
const degWithCompaction = degMeasured.filter(s => s.compactionStart > 0)
console.log(`  退化组有 compaction 的会话: ${degWithCompaction.length}/${degMeasured.length}`)
console.log(`  对照组有 compaction 的会话: ${ctlMeasured.filter(s => s.compactionStart > 0).length}/${ctlMeasured.length}`)

writeFileSync(outJson, JSON.stringify({
  generatedAt: new Date().toISOString(),
  degenerateSessions: degMeasured,
  controlSessions: ctlMeasured,
  table,
}, null, 1))
console.log(`\nraw data -> ${outJson}`)
