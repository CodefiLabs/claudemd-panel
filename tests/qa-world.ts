// QA helper: the author's world() plus symlinks, macOS-style aliases whose
// realPath keeps its own spelling, the documented 4 MiB read/write limit,
// a write log, and a hook to make "another program" write mid-save.
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const HOME = '/home/t'
export const FILE = `${HOME}/.claude/CLAUDE.md`
export const HIST = `${HOME}/.claude/claude-md-history`
const DIRS0 = ['/', '/home', HOME, `${HOME}/.claude`, '/tmp', `${HOME}/dotfiles`]
const LIMIT = 4 * 1024 * 1024

type FileRec = { text: string; mtimeMs: number; size?: number }

export type WorldOpts = {
  /** symlink path -> target (absolute). Followed by read/write/stat. */
  links?: Record<string, string>
  /** prefix -> prefix. A path under the alias reaches the target, but realPath keeps the alias spelling (firmlinks, /.vol, case aliases). */
  aliases?: Record<string, string>
  /** extra directories */
  dirs?: string[]
  /** paths that are directories, not files */
  dirFiles?: string[]
}

export function world(on: On, files: Record<string, string> = {}, opts: WorldOpts = {}) {
  const fs = new Map<string, FileRec>()
  const DIRS = new Set([...DIRS0, ...(opts.dirs ?? []), ...(opts.dirFiles ?? [])])
  const links = opts.links ?? {}
  const aliases = opts.aliases ?? {}
  let tick = 1_000
  const writes: Array<{ path: string; text: string }> = []
  let onWrite: ((path: string, text: string) => void) | null = null
  const put = (path: string, text: string, size?: number) => fs.set(path, { text, mtimeMs: ++tick, size })
  for (const [k, v] of Object.entries(files)) put(k, v)

  /** Follows aliases and symlinks (whole-path or directory-prefix links). */
  const target = (p0: string): string => {
    let p = p0
    for (let i = 0; i < 10; i++) {
      let moved = false
      for (const [a, t] of Object.entries(aliases)) {
        if (p === a || p.startsWith(`${a}/`)) {
          p = t + p.slice(a.length)
          moved = true
        }
      }
      for (const [l, t] of Object.entries(links)) {
        if (p === l || p.startsWith(`${l}/`)) {
          p = t + p.slice(l.length)
          moved = true
        }
      }
      if (!moved) break
    }
    return p
  }
  /** realPath: symlinks followed, aliases NOT folded (as the API documents). */
  const realOf = (p0: string): string => {
    let p = p0
    for (let i = 0; i < 10; i++) {
      let moved = false
      for (const [l, t] of Object.entries(links)) {
        if (p === l || p.startsWith(`${l}/`)) {
          p = t + p.slice(l.length)
          moved = true
        }
      }
      if (!moved) break
    }
    return p
  }
  const isDir = (p0: string) => {
    const p = target(p0)
    const d = p.replace(/\/$/, '') || '/'
    return DIRS.has(d) || [...fs.keys()].some(k => k.startsWith(`${d}/`))
  }
  const sizeOf = (r: FileRec) => r.size ?? new TextEncoder().encode(r.text).length

  mock.env(on, { HOME })
  const clock = mock.clock(on)
  on('fs.read', (_, e) => {
    const f = fs.get(target(e.path))
    if (f === undefined) return { deny: `ENOENT: ${e.path}` }
    if (sizeOf(f) > LIMIT) return { deny: 'EFBIG: over 4 MiB' }
    return { value: f.text }
  })
  on('fs.write', (_, e) => {
    if (new TextEncoder().encode(e.text).length > LIMIT) return { deny: 'EFBIG: a write over 4 MiB rejects' }
    if (DIRS.has(target(e.path))) return { deny: 'EISDIR' }
    writes.push({ path: e.path, text: e.text })
    onWrite?.(e.path, e.text)
    put(target(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: fs.has(target(e.path)) || isDir(e.path) }))
  on('fs.stat', (_, e) => {
    const t = target(e.path)
    const f = fs.get(t)
    const real = e.resolve ? { realPath: realOf(e.path) } : {}
    const isLink = Object.keys(links).includes(e.path)
    if (f !== undefined) return { value: { kind: 'file' as const, size: sizeOf(f), mtimeMs: f.mtimeMs, isLink, ...real } }
    if (isDir(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink, ...real } }
    return { deny: `ENOENT: ${e.path}` }
  })
  on('fs.list', (_, e) => {
    const d = target(e.path).replace(/\/$/, '')
    if (!isDir(d)) return { deny: `ENOENT: ${d}` }
    const value = [...fs.entries()]
      .filter(([k]) => k.startsWith(`${d}/`) && !k.slice(d.length + 1).includes('/'))
      .map(([k, f]) => ({ name: k.slice(d.length + 1), kind: 'file' as const, size: sizeOf(f), mtimeMs: f.mtimeMs, isLink: false }))
    return { value }
  })
  const opened: string[] = []
  const statuses: Array<string | undefined> = []
  on('ui.open', (_, e) => {
    opened.push(String((e as { id?: unknown }).id))
    return { value: { isPlaced: true as const } }
  })
  on('ui.status', (_, e) => {
    statuses.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'claudemd' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__claudemd-panel__propose_change' } }))
  let cwdNow = '/'
  on('session.start', (_, e) => {
    cwdNow = e.cwd
    return { cwd: e.cwd }
  })
  on('session.cwd', () => ({ value: cwdNow }))
  // A shell stand-in for the few programs the mod runs: rm, cp, cmp, open.
  const ran: string[][] = []
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    ran.push(argv)
    const done = (exitCode = 0) => ({ value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const last = argv[argv.length - 1] ?? ''
    if (argv[0] === '/bin/rm') {
      fs.delete(target(last))
      return done()
    }
    if (argv[0] === '/bin/cp') {
      const src = fs.get(target(argv[argv.length - 2] ?? ''))
      if (src === undefined) return done(1)
      fs.set(target(last), { ...src, mtimeMs: ++tick })
      return done()
    }
    if (argv[0] === '/usr/bin/cmp') {
      const a = fs.get(target(argv[argv.length - 2] ?? ''))
      const b = fs.get(target(last))
      return done(a !== undefined && b !== undefined && a.text === b.text && sizeOf(a) === sizeOf(b) ? 0 : 1)
    }
    return done()
  })
  const passed: Array<{ tool: string; e: Record<string, unknown> }> = []
  let effect: ((tool: string, e: Record<string, unknown>) => void) | null = null
  on('tool.call', (_, e) => {
    passed.push({ tool: String(e.tool), e: e as unknown as Record<string, unknown> })
    effect?.(String(e.tool), e as unknown as Record<string, unknown>)
    return { result: 'ran' }
  })
  const session = mock.session(on)
  const backups = () => [...fs.keys()].filter(k => k.startsWith(`${HIST}/`)).sort()
  return {
    fs,
    put,
    clock,
    passed,
    session,
    backups,
    writes,
    opened,
    statuses,
    setOnWrite: (fn: ((path: string, text: string) => void) | null) => {
      onWrite = fn
    },
    /** What the tool "did" when a call reaches the bottom: plays a shell command's effect on the fake disk. */
    onTool: (fn: ((tool: string, e: Record<string, unknown>) => void) | null) => {
      effect = fn
    },
    ran,
    remove: (path: string) => fs.delete(path),
    text: (p = FILE) => fs.get(p)?.text,
  }
}

export const PANE = {
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

export const SURFACES = ['desktop', 'terminal'] as const
