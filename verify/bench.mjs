/**
 * W1511 performance benchmark.
 *
 * Fair comparison: throughput is measured on a HEALTHY stream that never
 * convicts, so both the baseline and the guarded run drain every chunk. (An
 * earlier version measured on a collapsing stream and compared a run that
 * stopped early against one that did not — meaningless.)
 *
 * Run with: node --expose-gc bench.mjs
 */
const CONFIG = {
  windowChars: 2400, minWindowChars: 1200, minSegments: 24, minSegmentChars: 12,
  phraseRun: 8, phraseTopCount: 10, lowInfoDupShare: 0.85, maxUniqueGramRatio: 0.3,
  gramK: 5, evalEveryChars: 200, onsetGapSegments: 2, holdbackChars: 4096,
  modelIncludes: [], truncate: true, continueOnTruncate: true,
  maxTruncationsPerTurn: 2, logPath: null,
}
const CHUNK = 40
const module = await import('../index.js')

/** A large stream of genuinely distinct sentences — never convicts. */
function healthyStream(chars) {
  const parts = []
  let n = 0
  for (let i = 0; n < chars; i += 1) {
    const s = `Step ${i} reindexes shard ${(i * 7) % 251003} and verifies checksum ${(i * 2654435761) % 999983} before committing batch ${i}. `
    parts.push(s)
    n += s.length
  }
  const text = parts.join('')
  const chunks = []
  for (let i = 0; i < text.length; i += CHUNK) {
    chunks.push({ type: 'reasoning-delta', index: 0, text: text.slice(i, i + CHUNK) })
  }
  return { text, chunks }
}

async function run(chunks, holdbackChars) {
  if (holdbackChars === null) {
    let n = 0
    for (const c of chunks) n += c.text.length
    return { released: n }
  }
  const listeners = new Map()
  const agent = { id: 's-bench', inject: () => {} }
  module.apply({
    on: (e, l) => listeners.set(e, l),
    get: s => (s === 'agents' ? { get: () => agent } : undefined),
  }, { ...CONFIG, holdbackChars })
  async function* source() {
    for (const c of chunks) yield c
  }
  const stream = listeners.get('llm/stream')(
    { sessionId: 's-bench', provider: 'c', model: 'deepseek-flash' },
    () => source(),
  )
  let released = 0
  for await (const chunk of stream) released += (chunk.text ?? '').length
  return { released }
}

const gc = globalThis.gc ?? (() => {})
const heap = () => { gc(); return process.memoryUsage().heapUsed }

const { text, chunks } = healthyStream(4_000_000)
const mb = text.length / 1048576
console.log(`healthy stream: ${text.length.toLocaleString()} chars (${mb.toFixed(1)} MB), `
  + `${chunks.length.toLocaleString()} chunks — never convicts, so every run drains it fully\n`)

console.log('=== 吞吐（4 次取最好）===')
console.log(`  ${'配置'.padEnd(16)} ${'耗时'.padStart(8)} ${'吞吐'.padStart(14)}   释放`)
const rows = []
for (const [label, holdback] of [['无插件（基线）', null], ['holdback 0', 0], ['holdback 4096', 4096]]) {
  let best = Infinity
  let released = 0
  for (let i = 0; i < 4; i += 1) {
    const t0 = process.hrtime.bigint()
    const r = await run(chunks, holdback)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    if (ms < best) best = ms
    released = r.released
  }
  const rate = text.length / (best / 1000) / 1e6
  rows.push({ label, ms: best, rate, released })
  console.log(`  ${label.padEnd(16)} ${(best.toFixed(0) + ' ms').padStart(8)} ${(rate.toFixed(1) + ' Mchars/s').padStart(14)}   ${released.toLocaleString()}`)
}

const base = rows[0]
const guard = rows[2]
const perChunk = (guard.ms - base.ms) / chunks.length * 1000
console.log(`\n  每 chunk 开销: ${perChunk.toFixed(2)} µs  (${chunks.length.toLocaleString()} chunks)`)
console.log(`  每秒可处理:   ${(chunks.length / ((guard.ms - base.ms) / 1000)).toFixed(0)} chunks/s`)
const cpuShare = 16 * perChunk / 1e6 * 100
console.log(`  模型实际产出: 626 字符/秒 ≈ 16 chunks/s  →  占用单核 ${cpuShare.toFixed(3)}%`)

console.log('\n=== 内存 ===')
{
  const before = heap()
  await run(chunks, 4096)
  const after = heap()
  console.log(`  ${mb.toFixed(1)} MB 流处理完，堆增长 ${((after - before) / 1048576).toFixed(1)} MB`)
  console.log(`  保留上界 = windowChars(2400) + holdbackChars(4096) ≈ 6.5 K 字符，与流长无关`)
}

console.log('\n=== 定罪成本 ===')
{
  const { degenerationOnset } = module
  const held = text.slice(0, 4096)
  const t0 = process.hrtime.bigint()
  const N = 5000
  for (let i = 0; i < N; i += 1) degenerationOnset(held, CONFIG)
  const us = Number(process.hrtime.bigint() - t0) / 1000 / N
  console.log(`  找起点（4096 字符）: ${us.toFixed(0)} µs，每次定罪只跑一次`)
  console.log(`  对比一次模型调用 2–8 秒 → 可忽略`)
}

console.log('\n=== 剪枝的代价：输出延迟 ===')
console.log(`  holdback 扣住 ${CONFIG.holdbackChars} 字符再放行，用户看到的内容滞后这么多字符：\n`)
for (const rate of [200, 626, 1200]) {
  console.log(`    ${String(rate).padStart(4)} 字符/秒  →  ${(CONFIG.holdbackChars / rate).toFixed(1)} 秒`)
}
console.log(`\n  626 字符/秒 取自本插件真实日志 (seenChars 4834 / elapsedMs 7723)`)
console.log(`  这是精确剪枝唯一的真实代价；调小 holdbackChars 可线性降低，代价是剪枝精度下降。`)
