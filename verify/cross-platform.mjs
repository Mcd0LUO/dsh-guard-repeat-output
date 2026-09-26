// Cross-platform path/behavior verification for dsh-guard-repeat-output.
//
// These assertions drive the REAL exported helpers (not copies), so they fail if
// the implementation regresses. Path semantics are checked under win32 as well as
// the host platform, because that is where the Linux-only assumptions showed up.
import { strict as assert } from 'node:assert'
import { join, win32, posix, isAbsolute, dirname } from 'node:path'
import { existsSync, rmSync, readFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { safeFileName, expandConfiguredPath, harnessHome, appendRecord } from '../index.js'

const results = []
function check(label, fn) {
  try { fn(); results.push('PASS ' + label) }
  catch (e) { results.push('FAIL ' + label + ': ' + e.message) }
}

/* ---- 1. Path joining: the bug this fixes -------------------------------- */

check('host join() produces a native path', () => {
  assert.equal(join('/a/b', 'c.txt'), '/a/b/c.txt')
})

check('win32 join() uses backslashes where string concat would mix separators', () => {
  assert.equal(win32.join('C:\\logs', 'c.txt'), 'C:\\logs\\c.txt')
  // The pre-fix code did exactly this and produced 'C:\\logs/c.txt' on Windows.
  assert.notEqual('C:\\logs' + '/' + 'c.txt', win32.join('C:\\logs', 'c.txt'))
})

check('win32 join() does not double a trailing separator', () => {
  assert.equal(win32.join('C:\\logs\\', 'c.txt'), 'C:\\logs\\c.txt')
})

/* ---- 2. expandConfiguredPath: portable config resolution ---------------- */

check('absolute paths pass through unchanged on any platform', () => {
  assert.equal(expandConfiguredPath('/var/log/x.log'), '/var/log/x.log')
  assert.equal(expandConfiguredPath('C:\\logs\\x.log'), 'C:\\logs\\x.log')
  assert.equal(expandConfiguredPath('D:/logs/x.log'), 'D:/logs/x.log')
})

check('relative paths resolve under the harness home, not the process CWD', () => {
  const out = expandConfiguredPath('logs/x.log')
  assert.ok(isAbsolute(out), out)
  assert.equal(out, join(harnessHome(), 'logs/x.log'))
  assert.equal(dirname(out), join(harnessHome(), 'logs'))
})

check('~ and ~/x and ~\\x expand to the OS home', () => {
  assert.equal(expandConfiguredPath('~'), homedir())
  assert.equal(expandConfiguredPath('~/a/b'), join(homedir(), 'a/b'))
  assert.equal(expandConfiguredPath('~\\a\\b'), join(homedir(), 'a\\b'))
})

check('$DSH_HOME and ${DSH_HOME} expand to the harness home', () => {
  const home = harnessHome()
  assert.equal(expandConfiguredPath('$DSH_HOME/logs/x'), join(home, 'logs/x'))
  assert.equal(expandConfiguredPath('${DSH_HOME}/logs/x'), join(home, 'logs/x'))
})

check('null / empty disable the feature rather than resolving to CWD', () => {
  assert.equal(expandConfiguredPath(null), null)
  assert.equal(expandConfiguredPath(undefined), null)
  assert.equal(expandConfiguredPath(''), null)
  assert.equal(expandConfiguredPath('   '), null)
})

check('harnessHome honours an explicit DSH_HOME and ignores a blank one', () => {
  assert.equal(harnessHome({ DSH_HOME: '/custom/home' }), '/custom/home')
  assert.equal(harnessHome({ DSH_HOME: '   ' }), join(homedir(), '.dsh'))
  assert.equal(harnessHome({}), join(homedir(), '.dsh'))
})

/* ---- 3. safeFileName: Windows-illegal characters and device names ------- */

check('strips every Windows-illegal character', () => {
  const out = safeFileName('session:a/b?c*d"e<f>g|h.txt')
  assert.ok(!/[<>:"/\\|?*]/.test(out), out)
})

check('strips control characters', () => {
  assert.ok(!/[\u0000-\u001f]/.test(safeFileName('a\u0001b\u001fc')))
})

check('strips a trailing dot or space (Windows rejects both)', () => {
  assert.equal(safeFileName('name.'), 'name')
  assert.equal(safeFileName('name '), 'name')
})

check('escapes reserved device names', () => {
  assert.equal(safeFileName('CON'), '_CON')
  assert.equal(safeFileName('com1.txt'), '_com1.txt')
})

check('never returns an empty name', () => {
  assert.equal(safeFileName(''), 'unnamed')
  assert.equal(safeFileName(null), 'unnamed')
})

check('a real generated copy name stays legal', () => {
  const name = 'session-abc__t1__' + new Date().toISOString().replace(/[:.]/g, '-') + '__reasoning.txt'
  assert.equal(safeFileName(name), name)
  assert.ok(!/[<>:"/\\|?*]/.test(name))
})

/* ---- 4. Real filesystem I/O through the plugin's own code ---------------- */

const root = mkdtempSync(join(tmpdir(), 'guard-xplat-'))
try {
  // A fresh install has no log directory. appendFile() never creates parents on
  // any platform, so this is the regression that would silently lose records.
  const nested = join(root, 'a', 'b', 'probe.log')
  await appendRecord(nested, { event: 'probe', n: 1 })
  check('appendRecord creates missing parent directories', () => {
    assert.ok(existsSync(nested), nested)
    assert.match(readFileSync(nested, 'utf8'), /"event":"probe"/)
  })

  // The fast path (directory already present) must keep appending, not truncate.
  await appendRecord(nested, { event: 'probe', n: 2 })
  check('appendRecord appends rather than overwriting on the fast path', () => {
    const lines = readFileSync(nested, 'utf8').trim().split('\n').filter(Boolean)
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[1]).n, 2)
  })

  // A path that cannot be written must stay silent (diagnostics only).
  await appendRecord(join(root, 'probe.log', 'impossible.log'), { event: 'x' })
  check('appendRecord swallows an unwritable path instead of throwing', () => true)

  // A sanitized name must round-trip through a real write.
  const dir = join(root, 'pruned')
  const file = join(dir, safeFileName('session:a/b?c*t1__reasoning.txt'))
  const fs = await import('node:fs/promises')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(file, 'collapsed text')
  check('a sanitized name round-trips through a real write', () => {
    assert.ok(existsSync(file), file)
    assert.equal(readFileSync(file, 'utf8'), 'collapsed text')
    assert.ok(!/[<>:"/\\|?*]/.test(file.split(/[\\/]/).pop()))
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(results.join('\n'))
const failed = results.filter(r => r.startsWith('FAIL')).length
console.log('\n' + (failed === 0 ? 'PASS — all ' + results.length + ' cross-platform checks' : 'FAIL — ' + failed + ' check(s)'))
process.exit(failed === 0 ? 0 : 1)
