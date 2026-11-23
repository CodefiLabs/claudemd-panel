// QA2 helper: an in-memory disk closer to a real one than qa-world.
// - symlinks can be made, repointed and removed while a test runs; a dangling
//   link does not "exist", a write through it lands at its target
// - real directories: a path can become a directory; `rm -f` (no -r) leaves it
// - explicit mtimes (a script can `touch -r` the old time back); `cp -p` keeps mtime
// - non-UTF-8 files: raw bytes, read as text with replacement characters
// - writes under a prefix can be made to fail (EACCES)
// - a tool call reaching the bottom can be HELD open (async effect) so the test
//   can act while a Claude call runs
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const HOME = '/home/t'
export const FILE = `${HOME}/.claude/CLAUDE.md`
export const HIST = `${HOME}/.claude/claude-md-history`
const LIMIT = 4 * 1024 * 1024

type FileRec = { text: string; mtimeMs: number; size?: number; raw?: Uint8Array }

export type World2Opts = {
  links?: Record<string, string>
  dirs?: string[]
}

const b64 = (bytes: Uint8Array) => {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s)
}

export function gate() {
  let release!: () => void
  const p = new Promise<void>(r => {
    release = r
  })
  return { p, release }
}

/** Lets pending promise chains run (real timers; the mocked clock is separate). */
export const settle = (ms = 15) => new Promise<void>(r => setTimeout(r, ms))

export function world2(on: On, files: Record<string, string> = {}, opts: World2Opts = {}) {
  const fs = new Map<string, FileRec>()
  const dirs = new Set<string>(['/', '/home', HOME, `${HOME}/.claude`, '/tmp', `${HOME}/dotfiles`, `${HOME}/.ssh`, ...(opts.dirs ?? [])])
  const links = new Map<string, string>(Object.entries(opts.links ?? {}))
  let tick = 1_000
  const writes: Array<{ path: string; text: string }> = []
  let onWrite: ((path: string, text: string) => void) | null = null
  let onRead: ((path: string) => void) | null = null
  let failWrites: ((path: string) => boolean) | null = null
  let beforeStat: ((path: string) => void | Promise<void>) | null = null
  let beforeWrite: ((path: string, text: string) => void | Promise<void>) | null = null
  const put = (path: string, text: string, size?: number) => {
    fs.set(path, { text, mtimeMs: ++tick, size })
    dirs.delete(path)
  }
  for (const [k, v] of Object.entries(files)) put(k, v)

  const target = (p0: string): string => {
    let p = p0.replace(/\/+$/, '') || '/'
    for (let i = 0; i < 20; i++) {
      let moved = false
      for (const [l, t] of links) {
        if (p === l || p.startsWith(`${l}/`)) {
          p = t + p.slice(l.length)
          moved = true
          break
        }
      }
      if (!moved) break
    }
    return p
  }
  const parentLinked = (p: string) => target(p.slice(0, p.lastIndexOf('/')) || '/') + p.slice(p.lastIndexOf('/'))
  const isDir = (p0: string) => {
    const d = target(p0)
    return dirs.has(d) || [...fs.keys()].some(k => k.startsWith(`${d}/`))
  }
  const sizeOf = (r: FileRec) => r.size ?? (r.raw ? r.raw.length : new TextEncoder().encode(r.text).length)

  mock.env(on, { HOME })
  const clock = mock.clock(on)
  on('fs.read', (_, e) => {
    onRead?.(e.path)
    const t = target(e.path)
    if (dirs.has(t)) return { deny: `EISDIR: ${e.path}` }
    const f = fs.get(t)
    if (f === undefined) return { deny: `ENOENT: ${e.path}` }
    if (sizeOf(f) > LIMIT) return { deny: 'EFBIG: over 4 MiB' }
    const as = (e as { options?: { as?: string }; as?: string }).options?.as ?? (e as { as?: string }).as
    if (as === 'bytes') return { value: { base64: b64(f.raw ?? new TextEncoder().encode(f.text)) } } as never
    return { value: f.text }
  })
  on('fs.write', async (_, e) => {
    await beforeWrite?.(e.path, e.text)
    if (new TextEncoder().encode(e.text).length > LIMIT) return { deny: 'EFBIG: a write over 4 MiB rejects' }
    const t = target(e.path)
    if (dirs.has(t)) return { deny: 'EISDIR' }
    // a parent that is a regular file: ENOTDIR
    for (let i = t.lastIndexOf('/'); i > 0; i = t.lastIndexOf('/', i - 1)) if (fs.has(t.slice(0, i))) return { deny: 'ENOTDIR' }
    if (failWrites?.(t)) return { deny: 'EACCES: permission denied' }
    writes.push({ path: e.path, text: e.text })
    onWrite?.(e.path, e.text)
    put(t, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: fs.has(target(e.path)) || isDir(e.path) }))
  on('fs.stat', async (_, e) => {
    await beforeStat?.(e.path)
    const own = e.path.replace(/\/+$/, '') || '/'
    const isLink = links.has(own) || links.has(parentLinked(own))
    const t = target(own)
    const f = fs.get(t)
    const real = (e as { resolve?: boolean; options?: { resolve?: boolean } }).resolve || (e as { options?: { resolve?: boolean } }).options?.resolve ? { realPath: t } : {}
    if (f !== undefined) return { value: { kind: 'file' as const, size: sizeOf(f), mtimeMs: f.mtimeMs, isLink, ...real } }
    if (isDir(own)) return { value: { kind: 'dir' as const, size: 64, mtimeMs: 0, isLink, ...real } }
    if (isLink) return { value: { kind: 'other' as const, size: 0, mtimeMs: 0, isLink: true } }
    return { deny: `ENOENT: ${e.path}` }
  })
  on('fs.list', (_, e) => {
    const d = target(e.path ?? '/')
    if (!isDir(d)) return { deny: `ENOENT: ${d}` }
    const value: Array<{ name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }> = []
    for (const [k, f] of fs) if (k.startsWith(`${d}/`) && !k.slice(d.length + 1).includes('/')) value.push({ name: k.slice(d.length + 1), kind: 'file', size: sizeOf(f), mtimeMs: f.mtimeMs, isLink: false })
    for (const [l] of links) if (l.startsWith(`${d}/`) && !l.slice(d.length + 1).includes('/')) value.push({ name: l.slice(d.length + 1), kind: 'other', size: 0, mtimeMs: 0, isLink: true })
    for (const x of dirs) if (x.startsWith(`${d}/`) && !x.slice(d.length + 1).includes('/')) value.push({ name: x.slice(d.length + 1), kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
    return { value }
  })
  const toasts: string[] = []
  const statuses: Array<string | undefined> = []
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', (_, e) => {
    statuses.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: string; message?: string }).text ?? (e as { message?: string }).message ?? JSON.stringify(e)))
    return { value: undefined } as never
  })
  on('ui.panes', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'claudemd' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__claudemd-panel__propose_change' } }))
  let cwdNow = '/'
  on('session.start', (_, e) => {
    cwdNow = e.cwd
    return { cwd: e.cwd }
  })
  on('session.cwd', () => ({ value: cwdNow }))
  const ran: string[][] = []
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    ran.push(argv)
    const done = (exitCode = 0) => ({ value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const last = argv[argv.length - 1] ?? ''
    if (argv[0] === '/bin/rm') {
      const own = last.replace(/\/+$/, '')
      if (links.has(own)) {
        links.delete(own)
        return done()
      }
      const t = target(own)
      if (isDir(t)) return done(1) // rm -f without -r refuses a directory
      fs.delete(t)
      return done()
    }
    if (argv[0] === '/bin/ln') {
      // ln -sfn <target> <link>: replaces whatever is at <link> with a link
      const to = argv[argv.length - 2] ?? ''
      fs.delete(last)
      links.set(last.replace(/\/+$/, ''), to)
      return done()
    }
    if (argv[0] === '/bin/mv') {
      const from = (argv[argv.length - 2] ?? '').replace(/\/+$/, '')
      const to = last.replace(/\/+$/, '')
      const f = fs.get(from)
      if (f !== undefined) {
        fs.delete(from)
        fs.set(to, f)
        return done()
      }
      if (dirs.has(from)) {
        dirs.delete(from)
        dirs.add(to)
        for (const k of [...fs.keys()]) if (k.startsWith(`${from}/`)) {
          fs.set(to + k.slice(from.length), fs.get(k)!)
          fs.delete(k)
        }
        return done()
      }
      return done(1)
    }
    if (argv[0] === '/bin/mkdir') {
      dirs.add(target(last))
      return done()
    }
    if (argv[0] === '/bin/cp') {
      const src = fs.get(target(argv[argv.length - 2] ?? ''))
      if (src === undefined) return done(1)
      const dst = target(last)
      if (dirs.has(dst)) return done(1)
      if (failWrites?.(dst)) return done(1)
      fs.set(dst, { ...src, mtimeMs: argv.includes('-p') ? src.mtimeMs : ++tick })
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
  let effect: ((tool: string, e: Record<string, unknown>) => unknown) | null = null
  on('tool.call', async (_, e) => {
    passed.push({ tool: String(e.tool), e: e as unknown as Record<string, unknown> })
    const answer = (await effect?.(String(e.tool), e as unknown as Record<string, unknown>)) as unknown
    // An effect may answer for the engine, as a refused call does: { deny }.
    if (typeof answer === 'object' && answer !== null && 'deny' in answer) return answer as { deny: string }
    return { result: 'ran' }
  })
  const session = mock.session(on)
  const backups = () => [...fs.keys()].filter(k => k.startsWith(`${HIST}/`)).sort()
  return {
    fs,
    dirs,
    links,
    put,
    /** Sets a file's text and mtime exactly (a script that restores the old time). */
    putAt: (path: string, text: string, mtimeMs: number) => {
      fs.set(target(path), { text, mtimeMs })
    },
    /** Raw bytes (not UTF-8): reads as text with U+FFFD, as bytes exactly. */
    putRaw: (path: string, raw: Uint8Array) => {
      fs.set(target(path), { text: new TextDecoder().decode(raw), mtimeMs: ++tick, raw })
    },
    mkdir: (path: string) => {
      fs.delete(path)
      dirs.add(path)
    },
    link: (path: string, to: string) => {
      fs.delete(path)
      links.set(path, to)
    },
    unlink: (path: string) => links.delete(path),
    mtime: (path = FILE) => fs.get(target(path))?.mtimeMs,
    rec: (path = FILE) => fs.get(target(path)),
    clock,
    passed,
    session,
    backups,
    writes,
    toasts,
    statuses,
    ran,
    setOnWrite: (fn: ((path: string, text: string) => void) | null) => {
      onWrite = fn
    },
    setOnRead: (fn: ((path: string) => void) | null) => {
      onRead = fn
    },
    setBeforeStat: (fn: ((path: string) => void | Promise<void>) | null) => {
      beforeStat = fn
    },
    setBeforeWrite: (fn: ((path: string, text: string) => void | Promise<void>) | null) => {
      beforeWrite = fn
    },
    setFailWrites: (fn: ((path: string) => boolean) | null) => {
      failWrites = fn
    },
    onTool: (fn: ((tool: string, e: Record<string, unknown>) => unknown) | null) => {
      effect = fn
    },
    remove: (path: string) => fs.delete(path),
    text: (p = FILE) => fs.get(target(p))?.text,
    told: () => JSON.stringify(session.appended()),
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

export const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const
