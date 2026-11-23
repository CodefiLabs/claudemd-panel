import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { applyEdit, chunksOf, commandTouchesProtected, describeChange, diffOf, forDisplay, isReadOnlyCommand, normalizePath, pagesOf } from '../hooks/lib'
import type { DiffUnit } from '../hooks/lib'

const HOME = '/home/t'
const FILE = `${HOME}/.claude/CLAUDE.md`
const HIST = `${HOME}/.claude/claude-md-history`
const DIRS = new Set(['/', '/home', HOME, `${HOME}/.claude`])

type FileRec = { text: string; mtimeMs: number; size?: number }

/** The world beneath the mod: an in-memory disk, a clock, HOME, and an engine that places panes. */
function world(on: On, files: Record<string, string> = {}) {
  const fs = new Map<string, FileRec>()
  let tick = 1_000
  const put = (path: string, text: string, size?: number) => fs.set(path, { text, mtimeMs: ++tick, size })
  for (const [k, v] of Object.entries(files)) put(k, v)
  const isDir = (p: string) => {
    const d = p.replace(/\/$/, '') || '/'
    return DIRS.has(d) || [...fs.keys()].some(k => k.startsWith(`${d}/`))
  }
  const sizeOf = (r: FileRec) => r.size ?? new TextEncoder().encode(r.text).length

  mock.env(on, { HOME })
  const clock = mock.clock(on)
  on('fs.read', (_, e) => {
    const f = fs.get(e.path)
    if (f === undefined) return { deny: `ENOENT: ${e.path}` }
    if (sizeOf(f) > 4 * 1024 * 1024) return { deny: 'EFBIG' }
    return { value: f.text }
  })
  on('fs.write', (_, e) => {
    put(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: fs.has(e.path) || isDir(e.path) }))
  on('fs.stat', (_, e) => {
    const f = fs.get(e.path)
    const real = e.resolve ? { realPath: e.path } : {}
    if (f !== undefined) return { value: { kind: 'file' as const, size: sizeOf(f), mtimeMs: f.mtimeMs, isLink: false, ...real } }
    if (isDir(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, ...real } }
    return { deny: `ENOENT: ${e.path}` }
  })
  on('fs.list', (_, e) => {
    const d = e.path.replace(/\/$/, '')
    if (!isDir(d)) return { deny: `ENOENT: ${d}` }
    const value = [...fs.entries()]
      .filter(([k]) => k.startsWith(`${d}/`) && !k.slice(d.length + 1).includes('/'))
      .map(([k, f]) => ({ name: k.slice(d.length + 1), kind: 'file' as const, size: sizeOf(f), mtimeMs: f.mtimeMs, isLink: false }))
    return { value }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'claudemd' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__claudemd-panel__propose_change' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const argv = e.argv
    if (argv[0] === '/bin/rm') fs.delete(argv[argv.length - 1] ?? '')
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // Anything that reaches the bottom of tool.call "ran": the guard let it through. `effect` plays what the tool did.
  const passed: string[] = []
  let effect: ((tool: string, e: Record<string, unknown>) => void) | null = null
  on('tool.call', (_, e) => {
    passed.push(String(e.tool))
    effect?.(String(e.tool), e as unknown as Record<string, unknown>)
    return { result: 'ran' }
  })
  const session = mock.session(on)
  const backups = () => [...fs.keys()].filter(k => k.startsWith(`${HIST}/`)).sort()
  const onTool = (fn: ((tool: string, e: Record<string, unknown>) => void) | null) => {
    effect = fn
  }
  return { fs, put, clock, passed, session, backups, onTool, text: (p = FILE) => fs.get(p)?.text }
}

const PANE = {
  plugin: 'claudemd-panel',
  component: 'Pane',
  requestId: 'claudemd',
  props: {
    title: 'CLAUDE.md',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SURFACES = ['desktop', 'terminal'] as const

// ---------------------------------------------------------------- pure helpers

/** Applies unified hunks to `before`; a test oracle for diffOf. */
function patch(before: string, units: DiffUnit[]): string {
  const hunks = units.map(u => (u.kind === 'hunk' ? u.source : ''))
  const a = before.endsWith('\n') ? before.slice(0, -1).split('\n') : before === '' ? [] : before.split('\n')
  const out: string[] = []
  let i = 0
  for (const h of hunks) {
    const [head, ...lines] = h.split('\n')
    const m = /^@@ -(\d+),(\d+) \+\d+,\d+ @@$/.exec(head ?? '')
    if (m === null) throw new Error(`bad header ${head}`)
    const start = Number(m[2]) === 0 ? Number(m[1]) : Number(m[1]) - 1
    while (i < start) out.push(a[i++] ?? '')
    for (const l of lines) {
      if (l.startsWith(' ')) {
        out.push(a[i++] ?? '')
      } else if (l.startsWith('-')) {
        i++
      } else out.push(l.slice(1))
    }
  }
  while (i < a.length) out.push(a[i++] ?? '')
  return out.join('\n')
}

function rng(seed: number) {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

describe('lib', () => {
  test('diffOf round-trips on random edits', async () => {
    const r = rng(7)
    const words = ['alpha', 'beta', 'gamma', '# Head', '', '- item', 'delta']
    for (let n = 0; n < 300; n++) {
      const len = Math.floor(r() * 40)
      const a = Array.from({ length: len }, () => words[Math.floor(r() * words.length)] ?? '')
      const b = [...a]
      const edits = Math.floor(r() * 6)
      for (let k = 0; k < edits; k++) {
        const at = Math.floor(r() * (b.length + 1))
        const kind = r()
        if (kind < 0.4) b.splice(at, 0, words[Math.floor(r() * words.length)] ?? '')
        else if (kind < 0.8) b.splice(at, 1)
        else b[at] = 'changed'
      }
      const A = a.join('\n') + '\n'
      const B = b.join('\n') + '\n'
      const d = diffOf(A, B)
      expect(patch(A, d.units)).toBe(B.slice(0, -1))
      if (A === B) expect(d.isSame).toBe(true)
    }
  })

  test('diffOf falls back to a block replace past the edit cap, still correct', async () => {
    const A = Array.from({ length: 300 }, (_, i) => `a${i}`).join('\n')
    const B = Array.from({ length: 300 }, (_, i) => `b${i}`).join('\n')
    const d = diffOf(A, B, 50)
    expect(d.isApproximate).toBe(true)
    expect(patch(A, d.units)).toBe(B)
    expect(d.added).toBe(300)
    expect(d.removed).toBe(300)
  })

  test('diffOf handles empty, missing newline and huge files', async () => {
    expect(diffOf('', '').isSame).toBe(true)
    expect(patch('', diffOf('', 'x\n').units)).toBe('x')
    expect(patch('x\n', diffOf('x\n', '').units)).toBe('')
    expect(diffOf('a', 'a\n').notes[0]).toBe('Adds a newline at the end of the file.')
    const big = Array.from({ length: 60_000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
    const changed = big.replace('line 30000 ', 'LINE 30000 ')
    const d = diffOf(big, changed)
    expect(d.added).toBe(1)
    expect(d.removed).toBe(1)
    expect(d.units.length).toBe(1)
  })

  test('pagesOf keeps every unit whole and under the page size', async () => {
    const units: DiffUnit[] = Array.from({ length: 50 }, (_, i) => ({ kind: 'hunk' as const, source: `@@ -${i},1 +${i},1 @@\n-${'a'.repeat(1500)}\n+b` }))
    const pages = pagesOf(units, 20_000)
    expect(pages.flat().length).toBe(50)
    for (const p of pages) expect(p.reduce((n, u) => n + (u.kind === 'hunk' ? u.source.length : 0), 0) <= 20_000).toBe(true)
  })

  test('nothing is hidden: long lines come whole in pieces, big hunks split, invisible characters named, line endings reported', async () => {
    const long = 'x'.repeat(250_000) + 'TAIL'
    const d = describeChange('a\nb\n', `a\n${long}\n`)
    const pieces = d.units.filter(u => u.kind === 'long')
    expect(pieces.map(u => (u.kind === 'long' ? u.text : '')).join('')).toBe(long)
    for (const u of d.units) expect((u.kind === 'hunk' ? u.source.length : u.text.length) <= 21_000).toBe(true)
    const many = Array.from({ length: 3000 }, (_, i) => `line ${i} ${'z'.repeat(60)}`).join('\n')
    const big = describeChange('', many)
    for (const u of big.units) expect(u.kind === 'hunk' && u.source.length <= 21_000).toBe(true)
    expect(patch('', big.units)).toBe(many)
    expect(forDisplay('a\u200Bb\u202Ec')).toBe('a\u27e6U+200B\u27e7b\u27e6U+202E\u27e7c')
    const eol = describeChange('a\r\nb\r\n', 'a\nb\n')
    expect(eol.isSame).toBe(false)
    expect(eol.notes.join(' ')).toContain('CRLF to LF')
  })

  test('chunksOf covers the text exactly, within the limit', async () => {
    const r = rng(3)
    const lines: string[] = []
    for (let i = 0; i < 20_000; i++) lines.push(r() < 0.02 ? `## Section ${i}` : `text ${i} ${'y'.repeat(Math.floor(r() * 80))}`)
    lines.push('z'.repeat(100_000)) // one line longer than a part
    const text = lines.join('\n')
    const parts = chunksOf(text, 40_000)
    expect(parts[0]?.start).toBe(0)
    expect(parts[parts.length - 1]?.end).toBe(text.length)
    for (let i = 1; i < parts.length; i++) expect(parts[i]?.start).toBe(parts[i - 1]?.end)
    for (const p of parts) expect(p.end - p.start <= 40_000).toBe(true)
    expect(chunksOf('').length).toBe(1)
  })

  test('applyEdit follows the Edit tool', async () => {
    expect(applyEdit('a b a', { old: 'b', neu: 'c', all: false })).toEqual({ text: 'a c a' })
    expect('error' in applyEdit('a b a', { old: 'a', neu: 'c', all: false })).toBe(true)
    expect(applyEdit('a b a', { old: 'a', neu: '$&', all: true })).toEqual({ text: '$& b $&' })
    expect('error' in applyEdit('abc', { old: 'zz', neu: 'y', all: false })).toBe(true)
    expect(applyEdit('', { old: '', neu: 'new', all: false })).toEqual({ text: 'new' })
  })

  test('paths and commands', async () => {
    expect(normalizePath('~/.claude/../.claude/./CLAUDE.md', HOME)).toBe(FILE)
    expect(normalizePath(' CLAUDE.md ', HOME, `${HOME}/.claude`)).toBe(FILE)
    expect(normalizePath('.claude/CLAUDE.md', HOME, HOME)).toBe(FILE)
    expect(normalizePath(`/System/Volumes/Data${FILE}`, HOME)).toBe(FILE)
    const touches = (c: string) => commandTouchesProtected(c, HOME, FILE, HIST)
    expect(touches('echo x > ~/.claude/CLAUDE.md')).toBe(true)
    expect(touches('rm -rf "$HOME/.claude/claude-md-history"')).toBe(true)
    expect(touches('cd ~/.claude && echo x > CLAUDE.m[d]')).toBe(true)
    expect(touches('rm -rf ~/.claude')).toBe(true)
    expect(touches('mv ~/.claude ~/.claude-old')).toBe(true)
    expect(touches('ls ~/.claude')).toBe(false)
    expect(touches(`grep -n x ${HOME}/.claude/skills/a/CLAUDE.md > /tmp/out`)).toBe(false) // deeper in the folder: someone else's
    expect(touches('cd ~/.claude/dev-mods && echo "CLAUDE.md" > notes.txt')).toBe(false)
    expect(touches('cd ~/.claude && echo x > notes.txt; cat CLAUDE.md')).toBe(true)
    expect(touches('npm test')).toBe(false)
    expect(isReadOnlyCommand('cat ~/.claude/CLAUDE.md\nunlink ~/.claude/CLAUDE.md')).toBe(false)
    expect(isReadOnlyCommand('grep --pre=unlink x ~/.claude/CLAUDE.md')).toBe(false)
    expect(isReadOnlyCommand('cat ~/.claude/CLAUDE.md')).toBe(true)
    expect(isReadOnlyCommand('cat ~/.claude/CLAUDE.md > /tmp/x')).toBe(false)
    expect(isReadOnlyCommand('sed -i s/a/b/ ~/.claude/CLAUDE.md')).toBe(false)
    expect(forDisplay('a\u001b[31mb\r')).toBe('a␛[31mb␍')
  })
})

// ---------------------------------------------------------------- the panel

describe('panel', () => {
  test('a missing file offers Create; an empty one says so', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ text: /no global CLAUDE.md yet/ })) !== undefined).toBe(true)
      expect((await ui.find({ key: 'v-edit' }))?.text).toBe('Create')
      await ui.unmount()
    }
    w.put(FILE, '')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'v-refresh' })
    expect((await ui.find({ text: 'The file is empty.' })) !== undefined).toBe(true)
    await ui.unmount()
  })

  test('create, edit, review and save; a backup precedes every save over an existing file', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'v-edit' })
    await ui.input({ key: String((await ui.find({ type: 'Input' }))?.key), text: '# Rules\n\nBe brief.\n', kind: 'change' })
    await ui.press({ key: 'e-review' })
    expect((await ui.find({ type: 'Code' }))?.props.source).toContain('+Be brief.')
    expect(w.text()).toBe(undefined) // nothing written by reviewing
    await ui.press({ key: 'save' })
    expect(w.text()).toBe('# Rules\n\nBe brief.\n')
    expect(w.backups().length).toBe(0) // nothing existed to back up

    await ui.press({ key: 'v-edit' })
    await ui.input({ key: String((await ui.find({ type: 'Input' }))?.key), text: '# Rules\n\nBe very brief.\n', kind: 'change' })
    await ui.press({ key: 'e-review' })
    await ui.press({ key: 'save' })
    expect(w.text()).toBe('# Rules\n\nBe very brief.\n')
    expect(w.backups().length).toBe(1)
    expect(w.text(w.backups()[0])).toBe('# Rules\n\nBe brief.\n')
    expect((await ui.find({ text: /Saved\. The version before is backed up/ })) !== undefined).toBe(true)
    await ui.unmount()
  })

  test('Enter in the field goes to review; Discard leaves the file alone', async ($, on) => {
    const w = world(on, { [FILE]: 'one\n' })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'v-edit' })
    await ui.input({ key: String((await ui.find({ type: 'Input' }))?.key), text: 'two\n' }) // submit
    expect((await ui.find({ key: 'save' })) !== undefined).toBe(true)
    await ui.press({ key: 'r-discard' })
    expect(w.text()).toBe('one\n')
    expect(w.backups().length).toBe(0)
    await ui.unmount()
  })

  test('after Discard, editing again draws a fresh field holding the file, not the discarded typing', async ($, on) => {
    world(on, { [FILE]: 'one\n' })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'v-edit' })
    const first = await ui.find({ type: 'Input' })
    await ui.input({ key: String(first?.key), text: 'typed then discarded\n', kind: 'change' })
    await ui.press({ key: 'e-discard' })
    await ui.press({ key: 'v-edit' })
    const second = await ui.find({ type: 'Input' })
    expect(second?.key === first?.key).toBe(false)
    expect(second?.props.value).toBe('one\n')
    await ui.unmount()
  })

  test('an outside edit while editing: Save refuses, shows what changed, and nothing is lost', async ($, on) => {
    const w = world(on, { [FILE]: 'A\n' })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'v-edit' })
    await ui.input({ key: String((await ui.find({ type: 'Input' }))?.key), text: 'B\n', kind: 'change' })
    await ui.press({ key: 'e-review' })
    w.put(FILE, 'C\n') // another editor saves
    await w.clock.advance(2_100) // the poll notices
    expect((await ui.find({ text: /changed on disk since you started/ })) !== undefined).toBe(true)
    await ui.press({ key: 'save' })
    expect(w.text()).toBe('C\n') // not overwritten
    expect((await ui.find({ text: 'The file changed on disk' })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Code' }))?.props.source).toContain('+C')
    await ui.press({ key: 'rebase' })
    await ui.press({ key: 'save' })
    expect(w.text()).toBe('B\n')
    expect(w.backups().some(k => w.text(k) === 'C\n')).toBe(true) // the outside version is kept
    expect(w.backups().some(k => w.text(k) === 'A\n')).toBe(true) // and the one before it
    await ui.unmount()
  })

  test('Claude’s Edit becomes a proposal; Reject writes nothing and tells Claude', async ($, on) => {
    const w = world(on, { [FILE]: 'keep this\nold line\n' })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const res = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'old line', new_string: 'new line' })
    expect(String(res.deny)).toContain('shown to the user as a diff')
    expect(w.text()).toBe('keep this\nold line\n')
    expect(w.passed.includes('Edit')).toBe(false)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ text: 'Claude proposes a change' })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Code' }))?.props.source).toContain('+new line')
    await ui.press({ key: 'reject' })
    expect(w.text()).toBe('keep this\nold line\n')
    expect(w.backups().length).toBe(0)
    expect(JSON.stringify(w.session.appended())).toContain('REJECTED')
    expect((await ui.find({ text: /Rejected\. The file was not changed/ })) !== undefined).toBe(true)
    await ui.unmount()
  })

  test('a rejected proposal leaves the person’s own draft intact', async ($, on) => {
    const w = world(on, { [FILE]: 'x\n' })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'v-edit' })
    await ui.input({ key: String((await ui.find({ type: 'Input' }))?.key), text: 'my draft\n', kind: 'change' })
    await ui.press({ key: 'e-back' })
    await $.tool.call({ tool: 'Write', file_path: FILE, content: 'claude version\n' })
    await ui.press({ key: 'reject' })
    expect((await ui.find({ text: 'You have unsaved changes.' })) !== undefined).toBe(true)
    await ui.press({ key: 'v-review' })
    expect((await ui.find({ type: 'Code' }))?.props.source).toContain('+my draft')
    expect(w.text()).toBe('x\n')
    await ui.unmount()
  })

  test('Accept writes Claude’s version after a backup; consecutive Edits combine', async ($, on) => {
    const w = world(on, { [FILE]: 'a\nb\nc\n' })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'a', new_string: 'A' })
    await $.tool.call({ tool: 'Edit', file_path: '/home/t/.claude/claude.md', old_string: 'c', new_string: 'C' }) // case-folded spelling
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'accept' })
    expect(w.text()).toBe('A\nb\nC\n')
    expect(w.text(w.backups()[0])).toBe('a\nb\nc\n')
    expect(JSON.stringify(w.session.appended())).toContain('ACCEPTED')
    await ui.unmount()
  })

  test('the propose_change tool stages, and an identical proposal is refused', async ($, on) => {
    const w = world(on, { [FILE]: 'same\n' })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const same = await $.tool.call({ tool: 'mcp__claudemd-panel__propose_change', content: 'same\n' } as never)
    expect(String((same as { result?: unknown }).result)).toContain('nothing to review')
    const ok = await $.tool.call({ tool: 'mcp__claudemd-panel__propose_change', content: 'different\n', summary: 'Tighten it.' } as never)
    expect(String((ok as { result?: unknown }).result)).toContain('Shown to the user')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ text: 'Tighten it.' })) !== undefined).toBe(true)
    expect(w.text()).toBe('same\n')
    await ui.unmount()
  })

  test('a proposal over a file that changed meanwhile: Accept refuses, re-apply merges', async ($, on) => {
    const w = world(on, { [FILE]: 'one\ntwo\nthree\n' })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'two', new_string: 'TWO' })
    w.put(FILE, 'one\ntwo\nthree\nfour\n')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'accept' })
    expect(w.text()).toBe('one\ntwo\nthree\nfour\n')
    expect((await ui.find({ text: 'The file changed on disk' })) !== undefined).toBe(true)
    await ui.press({ key: 'reapply' })
    await ui.press({ key: 'accept' })
    expect(w.text()).toBe('one\nTWO\nthree\nfour\n')
    await ui.unmount()
  })

  test('the guard: shell writes, backups and other spellings are refused; reads and other files pass', async ($, on) => {
    const w = world(on, { [FILE]: 'x\n' })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const bad = [
      'echo hi > ~/.claude/CLAUDE.md',
      `sed -i '' s/x/y/ ${FILE}`,
      'cp /tmp/a $HOME/.claude/CLAUDE.md',
      'rm -rf ~/.claude/claude-md-history',
      `cat ${FILE} | tee ${FILE}.bak`,
    ]
    for (const command of bad) {
      const r = await $.tool.call({ tool: 'Bash', command })
      expect(r.deny !== undefined).toBe(true)
    }
    expect((await $.tool.call({ tool: 'Bash', command: 'cat ~/.claude/CLAUDE.md' })).deny).toBe(undefined)
    expect((await $.tool.call({ tool: 'Bash', command: 'echo hi > /repo/.claude/CLAUDE.md' })).deny).toBe(undefined)
    expect((await $.tool.call({ tool: 'Write', file_path: `${HIST}/CLAUDE.md.x.md`, content: '' })).deny).toContain('backups')
    expect((await $.tool.call({ tool: 'Write', file_path: '/repo/CLAUDE.md', content: 'ok' })).deny).toBe(undefined)
    const sneaky = await $.tool.call({ tool: 'Write', file_path: `${HOME}/.claude/../.claude/CLAUDE.md`, content: 'y\n' })
    expect(String(sneaky.deny)).toContain('shown to the user')
    expect(w.text()).toBe('x\n')
  })

  test('a huge file is paged; editing one part saves the whole file correctly', async ($, on) => {
    const sections = Array.from({ length: 22 }, (_, i) => `## Section ${i}\n${`Rule ${i}: ${'lorem ipsum '.repeat(60)}\n`.repeat(12)}`)
    const big = sections.join('\n')
    const w = world(on, { [FILE]: big })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const label = await ui.find({ text: /^Part 1 of \d+/ })
    expect(label !== undefined).toBe(true)
    const md = await ui.find({ type: 'Markdown' })
    expect(String(md?.props.text).length <= 40_000).toBe(true)
    await ui.press({ key: 'v-next' })
    await ui.press({ key: 'v-edit' })
    const field = await ui.find({ type: 'Input' })
    const start = String(field?.props.value)
    expect(start.length <= 40_000).toBe(true)
    await ui.input({ key: String(field?.key), text: start.replace('Rule', 'RULE'), kind: 'change' })
    await ui.press({ key: 'e-review' })
    const code = String((await ui.find({ type: 'Code' }))?.props.source)
    expect(code.length < 10_000).toBe(true)
    await ui.press({ key: 'save' })
    const at = big.indexOf(start)
    expect(w.text()).toBe(big.slice(0, at) + start.replace('Rule', 'RULE') + big.slice(at + start.length))
    await ui.unmount()
  })

  test('a file over the panel limit is described, not loaded, and cannot be edited here', async ($, on) => {
    const w = world(on)
    w.put(FILE, '', 5 * 1024 * 1024)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ text: /over the panel/ })) !== undefined).toBe(true)
    expect(await ui.find({ key: 'v-edit' })).toBe(undefined)
    const r = await $.tool.call({ tool: 'Write', file_path: FILE, content: 'x' })
    expect(String(r.deny)).toContain('Not staged')
    await ui.unmount()
  })

  test('control characters draw safely and block in-panel editing', async ($, on) => {
    world(on, { [FILE]: 'ok\u001b[31m red\u0000\n' })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(String((await ui.find({ type: 'Markdown' }))?.props.text)).toContain('␛')
      await ui.press({ key: 'v-edit' })
      expect((await ui.find({ text: /control characters/ })) !== undefined).toBe(true)
      await ui.unmount()
    }
  })

  test('CRLF line endings survive an edit', async ($, on) => {
    const w = world(on, { [FILE]: 'a\r\nb\r\n' })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'v-edit' })
    expect(String((await ui.find({ type: 'Input' }))?.props.value)).toBe('a\nb\n')
    await ui.input({ key: String((await ui.find({ type: 'Input' }))?.key), text: 'a\nB\n', kind: 'change' })
    await ui.press({ key: 'e-review' })
    await ui.press({ key: 'save' })
    expect(w.text()).toBe('a\r\nB\r\n')
    await ui.unmount()
  })

  test('history lists backups and restores one, backing up the current version first', async ($, on) => {
    const w = world(on, { [FILE]: 'v1\n' })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    for (const next of ['v2\n', 'v3\n']) {
      await ui.press({ key: 'v-edit' })
      const field = await ui.find({ type: 'Input' })
      await ui.input({ key: String(field?.key), text: next, kind: 'change' })
      await ui.press({ key: 'e-review' })
      await ui.press({ key: 'save' })
      await w.clock.advance(5)
    }
    expect(w.backups().length).toBe(2)
    await ui.press({ key: 'v-history' })
    const oldest = w.backups().find(k => w.text(k) === 'v1\n') ?? ''
    await ui.press({ key: `h-${oldest.slice(HIST.length + 1)}` })
    expect((await ui.find({ type: 'Code' }))?.props.source).toContain('+v1')
    await ui.press({ key: 'restore' })
    expect(w.text()).toBe('v1\n')
    expect(w.backups().length).toBe(3)
    expect(w.backups().some(k => w.text(k) === 'v3\n')).toBe(true)
    await ui.unmount()
  })
})
