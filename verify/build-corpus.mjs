/**
 * W1511 corpus extraction — freeze the real degenerate blocks to disk.
 *
 * Reads the 25 sessions the corpus scan convicted, re-runs the shipped detector
 * over each convicted block, and writes:
 *
 *   corpus/<workspace>__<session>__seq<N>__<channel>.txt   one block per file
 *   corpus/index.json                                      machine-readable index
 *
 * `triggerAtChar` is the character position where the incremental detector first
 * convicts, measured with the same 40-character chunking the scan used so the
 * numbers in the index agree with the numbers in the report.
 *
 * Session logs live under /opt/dsh (root-only), so each is decompressed through
 * `sudo -n zstd -dc` into a temp file first.
 *
 * Usage: node build-corpus.mjs <sessionsJson> <corpusDir> <stageDir>
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import { join, basename } from 'node:path'
import { RepetitionGuard } from '../index.js'

const sessionsJson = process.argv[2]
const corpusDir = process.argv[3]
const stageDir = process.argv[4]
const DELTA = 40

const sessionPaths = JSON.parse(readFileSync(sessionsJson, 'utf8'))
mkdirSync(corpusDir, { recursive: true })
mkdirSync(stageDir, { recursive: true })

/**
 * Normalize a workspace directory name into a filename-safe token.
 * The layout is `<root>/sessions/<workspaceDir>/<sessionDir>/session.v3.jsonl.zstd`,
 * so the workspace is the THIRD component from the end.
 * `--server-center-runtime-worker-exec--` -> `server-center-runtime-worker-exec`
 */
function workspaceOf(sessionPath) {
  const parts = sessionPath.split('/')
  const wsDir = parts[parts.length - 3] ?? 'unknown'
  const stripped = wsDir.replace(/^-+/, '').replace(/-+$/, '')
  return (stripped.length > 0 ? stripped : 'root').replace(/[^A-Za-z0-9._-]+/g, '-')
}

/** Session id: the session directory name, with any `session-` prefix removed. */
function sessionOf(sessionPath) {
  return basename(sessionPath.replace(/\/[^/]+$/, '')).replace(/^session-/, '')
}

/** Feed a block through a fresh guard; return the first conviction. */
function judge(text, channel) {
  const guard = new RepetitionGuard()
  for (let i = 0; i < text.length; i += DELTA) {
    const evidence = guard.push(text.slice(i, i + DELTA), channel)
    if (evidence !== null) return { evidence, at: i + DELTA }
  }
  return null
}

/**
 * Local (server) calendar date of a session log's last write, as YYYY-MM-DD.
 *
 * The logs are root-only, so `statSync` cannot read them directly — ask `stat`
 * through sudo instead of silently degrading to "unknown".
 */
function dateOf(sessionPath) {
  try {
    const out = execFileSync('sudo', ['-n', 'stat', '-c', '%y', sessionPath], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    const parsed = new Date(out)
    if (Number.isNaN(parsed.getTime())) throw new Error(`unparsable mtime: ${out}`)
    return parsed.toLocaleDateString('sv-SE')
  } catch (error) {
    console.error(`  WARN no date for ${sessionPath}: ${String(error).slice(0, 60)}`)
    return 'unknown'
  }
}

const index = []
let files = 0

for (const sessionPath of sessionPaths) {
  const workspace = workspaceOf(sessionPath)
  const session = sessionOf(sessionPath)
  const date = dateOf(sessionPath)

  // Decompress once per session into the staging dir.
  const staged = join(stageDir, `${session}.jsonl`)
  try {
    const out = execFileSync('sudo', ['-n', 'zstd', '-dc', sessionPath], {
      maxBuffer: 1024 * 1024 * 512,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    writeFileSync(staged, out)
  } catch (error) {
    console.error(`  SKIP ${session}: ${String(error).slice(0, 80)}`)
    continue
  }

  const rl = createInterface({ input: createReadStream(staged), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.includes('"assistant/message"')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type !== 'assistant/message') continue
    const seq = event.seq
    for (const block of event?.data?.message?.content ?? []) {
      if (block?.type !== 'reasoning' && block?.type !== 'text') continue
      const text = typeof block.text === 'string' ? block.text : ''
      if (text.length < 1200) continue
      const channel = block.type === 'reasoning' ? 'reasoning' : 'text'
      const hit = judge(text, channel)
      if (hit === null) continue

      const e = hit.evidence
      const name = `${workspace}__${session}__seq${seq}__${channel}.txt`
      writeFileSync(join(corpusDir, name), text)
      files += 1
      index.push({
        file: name,
        workspace,
        session,
        seq,
        channel,
        date,
        chars: text.length,
        triggerAtChar: hit.at,
        kind: e.kind,
        topPhrase: e.topPhrase,
        topPhraseCount: e.topPhraseCount,
        longestRun: e.longestRun,
        segments: e.segments,
        duplicateShare: Number(e.duplicateShare.toFixed(4)),
        uniqueGramRatio: Number(e.uniqueGramRatio.toFixed(4)),
        turn: event?.data?.turn,
        step: event?.data?.step,
      })
    }
  }
  rmSync(staged, { force: true })
  console.error(`  ${session}: cumulative ${files} blocks`)
}

// The live trigger: the plugin convicted this block on a real stream, so it is
// the first positive evidence of the full detect -> truncate -> continue loop.
const LIVE = 'd775ca96-0ce3-41c8-b7cf-1ddd7358d56c'
for (const entry of index) {
  if (entry.session === LIVE && entry.seq === 1503 && entry.channel === 'reasoning') {
    entry.note = 'live-trigger'
  }
}

index.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.file < b.file ? -1 : 1))
writeFileSync(join(corpusDir, 'index.json'), `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  detector: 'dsh-guard-repeat-output',
  chunkingChars: DELTA,
  count: index.length,
  byDate: index.reduce((acc, e) => {
    acc[e.date] = (acc[e.date] ?? 0) + 1
    return acc
  }, {}),
  entries: index,
}, null, 1)}\n`)

console.log(`\nwrote ${files} block files + index.json to ${corpusDir}`)
