// Pure helpers for the claudemd-panel mod: no `$`, so tests can call them directly.

/** Largest file the panel shows, edits or stages (Claude Code itself warns far below this). */
export const PANEL_MAX_BYTES = 256 * 1024
/** Largest part of the file drawn or edited at once. */
export const CHUNK_MAX = 40_000
/** Largest diff page drawn at once (a tree draws 100,000 characters). */
export const DIFF_PAGE_MAX = 60_000
/** A hunk is split into consecutive hunks past this many characters. */
export const HUNK_CHAR_MAX = 20_000
/** A diff line longer than this is drawn on its own, in pieces, never cut. */
export const LINE_SHOW_MAX = 2_000
/** Lines of context around each change. */
export const CONTEXT = 3
/** Edit distance past which the diff stops searching and shows a block replace. */
export const MAX_EDIT_DISTANCE = 1_500

// ---------------------------------------------------------------- display text

/**
 * Characters that draw as nothing, as a space, or change what is drawn around
 * them: every format character (bidi controls, zero-width joiners, the TAG
 * block that can spell hidden text), line and paragraph separators, variation
 * selectors, the invisible "letters" (Hangul fillers, Khmer vowels, the
 * combining grapheme joiner) and spaces other than the plain one.
 */
const INVISIBLE =
  /[\p{Cf}\p{Zl}\p{Zp}\u00A0\u034F\u115F\u1160\u1680\u17B4\u17B5\u180B-\u180F\u2000-\u200A\u202F\u205F\u3000\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/gu

/**
 * Text the Markdown and Code elements accept and a person can trust: control
 * characters become their symbols (tab and newline are kept), and invisible
 * or direction-changing characters are named, so nothing in a diff is hidden.
 * Display only; never applied to what is saved.
 */
export function forDisplay(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F\u0080-\u009F]/g, ch => {
      const code = ch.charCodeAt(0)
      if (code < 0x20) return String.fromCharCode(0x2400 + code)
      if (code === 0x7f) return '\u2421'
      return '\uFFFD'
    })
    .replace(INVISIBLE, ch => `⟦U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟧`)
}

/** A changed line's trailing spaces and tabs, made visible, so a whitespace-only change shows. */
function showTrailing(line: string): string {
  return line.replace(/[ \t]+$/, m => m.replace(/ /g, '·').replace(/\t/g, '→'))
}

/** True when the text holds a control character other than tab, newline or a CRLF's CR. */
export function hasOddControls(text: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]|\r(?!\n)/.test(text)
}

export type Endings = 'none' | 'lf' | 'crlf' | 'mixed'

export function endingsOf(text: string): Endings {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const all = (text.match(/\n/g) ?? []).length
  if (all === 0) return 'none'
  if (crlf === 0) return 'lf'
  return crlf === all ? 'crlf' : 'mixed'
}

export function toLF(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

export function lineCount(text: string): number {
  if (text === '') return 0
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return text.endsWith('\n') ? n - 1 : n
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

// ---------------------------------------------------------------- parts (paging)

export type Chunk = { start: number; end: number; label: string }

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function labelOf(text: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(text)
  const line = heading?.[1] ?? text.split('\n').find(l => l.trim() !== '') ?? ''
  const one = line.trim()
  return one.length > 60 ? `${one.slice(0, 59)}…` : one
}

/**
 * Splits text into parts of at most `max` characters, preferring to break
 * before a markdown heading once a part is half full, else at a line end,
 * and inside a line only when one line alone is longer than `max`.
 * Parts are contiguous and cover the text exactly.
 */
export function chunksOf(text: string, max = CHUNK_MAX): Chunk[] {
  if (text.length <= max) return [{ start: 0, end: text.length, label: labelOf(text) }]
  const spans: Array<[number, number]> = []
  let start = 0
  let pos = 0
  while (pos < text.length) {
    const size = pos - start
    if (size >= max / 2 && text.charCodeAt(pos) === 35 /* # */ && /^#{1,6}\s/.test(text.slice(pos, pos + 8))) {
      spans.push([start, pos])
      start = pos
    }
    const nl = text.indexOf('\n', pos)
    const lineEnd = nl === -1 ? text.length : nl + 1
    if (lineEnd - start > max) {
      if (pos > start) {
        spans.push([start, pos])
        start = pos
      }
      if (lineEnd - start > max) {
        let cut = start + max
        if (isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1
        spans.push([start, cut])
        start = cut
        pos = cut
        continue
      }
    }
    pos = lineEnd
  }
  if (start < text.length) spans.push([start, text.length])
  return spans.map(([s, e]) => ({ start: s, end: e, label: labelOf(text.slice(s, e)) }))
}

// ---------------------------------------------------------------- diff

type Op = { t: ' ' | '-' | '+'; line: string }

/** One drawable piece of a diff: a whole unified hunk, or a piece of one very long line. */
export type DiffUnit =
  | { kind: 'hunk'; source: string }
  | { kind: 'long'; sign: ' ' | '-' | '+'; lineNo: number; piece: number; pieces: number; length: number; text: string }

export type Diff = {
  units: DiffUnit[]
  added: number
  removed: number
  /** True when the two texts are byte-for-byte the same. */
  isSame: boolean
  /** Notes on what the lines alone don't show: the final newline, line endings. */
  notes: string[]
  /** True when the search gave up and the change is shown as one block replacing another. */
  isApproximate: boolean
}

function splitLines(text: string): { lines: string[]; eol: boolean } {
  const eol = text.endsWith('\n')
  const body = eol ? text.slice(0, -1) : text
  if (body === '' && !eol) return { lines: [], eol }
  return { lines: body.split('\n'), eol }
}

/** Myers' O((N+M)D) diff over interned lines; null past `maxD` edits. */
function myers(a: Int32Array, b: Int32Array, maxD: number): Array<' ' | '-' | '+'> | null {
  const n = a.length
  const m = b.length
  const max = n + m
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  outer: for (let d = 0; d <= max; d++) {
    if (d > maxD) return null
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)) x = v[off + k + 1]!
      else x = v[off + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        found = d
        break outer
      }
    }
  }
  if (found < 0) return null
  const script: Array<' ' | '-' | '+'> = []
  let x = n
  let y = m
  for (let d = found; d >= 0; d--) {
    const t = trace[d]!
    const at = (k: number) => t[k + d + 1]!
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      script.push(' ')
      x--
      y--
    }
    if (d > 0) script.push(x === prevX ? '+' : '-')
    x = prevX
    y = prevY
  }
  return script.reverse()
}

/** A line diff of `before` → `after` (LF text), as drawable units. */
export function diffOf(before: string, after: string, maxD = MAX_EDIT_DISTANCE): Diff {
  if (before === after) return { units: [], added: 0, removed: 0, isSame: true, notes: [], isApproximate: false }
  const A = splitLines(before)
  const B = splitLines(after)
  const a = A.lines
  const b = B.lines
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const aMid = a.slice(pre, a.length - suf)
  const bMid = b.slice(pre, b.length - suf)

  const ids = new Map<string, number>()
  const intern = (lines: string[]) => {
    const out = new Int32Array(lines.length)
    lines.forEach((l, i) => {
      let id = ids.get(l)
      if (id === undefined) {
        id = ids.size
        ids.set(l, id)
      }
      out[i] = id
    })
    return out
  }
  const script = aMid.length === 0 || bMid.length === 0 ? null : myers(intern(aMid), intern(bMid), maxD)
  const isApproximate = script === null && aMid.length > 0 && bMid.length > 0

  const ops: Op[] = []
  for (let i = 0; i < pre; i++) ops.push({ t: ' ', line: a[i]! })
  if (script === null) {
    for (const line of aMid) ops.push({ t: '-', line })
    for (const line of bMid) ops.push({ t: '+', line })
  } else {
    let i = 0
    let j = 0
    for (const s of script) {
      if (s === ' ') {
        ops.push({ t: ' ', line: aMid[i]! })
        i++
        j++
      } else if (s === '-') {
        ops.push({ t: '-', line: aMid[i]! })
        i++
      } else {
        ops.push({ t: '+', line: bMid[j]! })
        j++
      }
    }
  }
  for (let i = a.length - suf; i < a.length; i++) ops.push({ t: ' ', line: a[i]! })

  const oldBefore = new Int32Array(ops.length + 1)
  const newBefore = new Int32Array(ops.length + 1)
  let added = 0
  let removed = 0
  ops.forEach((op, i) => {
    oldBefore[i + 1] = oldBefore[i]! + (op.t === '+' ? 0 : 1)
    newBefore[i + 1] = newBefore[i]! + (op.t === '-' ? 0 : 1)
    if (op.t === '+') added++
    if (op.t === '-') removed++
  })

  const units: DiffUnit[] = []
  const header = (s: number, e: number) => {
    const oldLen = oldBefore[e]! - oldBefore[s]!
    const newLen = newBefore[e]! - newBefore[s]!
    const oldStart = oldLen === 0 ? oldBefore[s]! : oldBefore[s]! + 1
    const newStart = newLen === 0 ? newBefore[s]! : newBefore[s]! + 1
    return `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`
  }
  // A range of ops becomes hunks of bounded size; a very long line becomes pieces of its own.
  const emit = (from: number, to: number) => {
    let s = from
    let size = 0
    const flush = (e: number) => {
      if (e > s) {
        const lines = [header(s, e)]
        for (let i = s; i < e; i++) {
          const op = ops[i]!
          lines.push(`${op.t}${forDisplay(op.t === ' ' ? op.line : showTrailing(op.line))}`)
        }
        units.push({ kind: 'hunk', source: lines.join('\n') })
      }
      s = e
      size = 0
    }
    for (let i = from; i < to; i++) {
      const op = ops[i]!
      if (op.line.length > LINE_SHOW_MAX) {
        flush(i)
        const shown = forDisplay(op.line)
        const pieces = Math.ceil(shown.length / HUNK_CHAR_MAX)
        const lineNo = op.t === '-' ? oldBefore[i]! + 1 : newBefore[i]! + 1
        for (let p = 0; p < pieces; p++) {
          units.push({ kind: 'long', sign: op.t, lineNo, piece: p + 1, pieces, length: op.line.length, text: shown.slice(p * HUNK_CHAR_MAX, (p + 1) * HUNK_CHAR_MAX) })
        }
        s = i + 1
        continue
      }
      if (size + op.line.length > HUNK_CHAR_MAX) flush(i)
      size += op.line.length + 2
    }
    flush(to)
  }
  let i = 0
  while (i < ops.length) {
    while (i < ops.length && ops[i]!.t === ' ') i++
    if (i >= ops.length) break
    const from = Math.max(0, i - CONTEXT)
    let last = i
    let j = i
    while (j < ops.length) {
      if (ops[j]!.t !== ' ') last = j
      else if (j - last > 2 * CONTEXT) break
      j++
    }
    const to = Math.min(ops.length, last + CONTEXT + 1)
    emit(from, to)
    i = to
  }

  const notes: string[] = []
  if (A.eol !== B.eol) notes.push(B.eol ? 'Adds a newline at the end of the file.' : 'Removes the newline at the end of the file.')
  return { units, added, removed, isSame: false, notes, isApproximate }
}

/** The edit script turning lines `a` into lines `b` (common ends trimmed first; a block replace past the cap). */
function lineScript(a: string[], b: string[]): Array<' ' | '-' | '+'> {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const aMid = a.slice(pre, a.length - suf)
  const bMid = b.slice(pre, b.length - suf)
  const ids = new Map<string, number>()
  const intern = (lines: string[]) => Int32Array.from(lines, l => {
    let id = ids.get(l)
    if (id === undefined) {
      id = ids.size
      ids.set(l, id)
    }
    return id
  })
  const mid = aMid.length === 0 || bMid.length === 0 ? null : myers(intern(aMid), intern(bMid), MAX_EDIT_DISTANCE)
  const middle: Array<' ' | '-' | '+'> = mid ?? [...aMid.map(() => '-' as const), ...bMid.map(() => '+' as const)]
  return [...Array.from({ length: pre }, () => ' ' as const), ...middle, ...Array.from({ length: suf }, () => ' ' as const)]
}

/**
 * Gives an edited LF text the line endings of the file it came from: an
 * unchanged line keeps its own ending, a new or changed line takes the file's
 * most common one. So editing one line of a CRLF or mixed file changes only
 * the bytes of that line.
 */
export function restoreEndings(original: string, editedLF: string): string {
  if (!original.includes('\r')) return editedLF
  const pieces = original.match(/[^\n]*(?:\n|$)/g) ?? []
  const lines: Array<{ text: string; end: string }> = []
  for (const piece of pieces) {
    if (piece === '') continue
    const end = piece.endsWith('\r\n') ? '\r\n' : piece.endsWith('\n') ? '\n' : ''
    lines.push({ text: piece.slice(0, piece.length - end.length), end })
  }
  const crlf = lines.filter(l => l.end === '\r\n').length
  const lf = lines.filter(l => l.end === '\n').length
  const usual = crlf >= lf ? '\r\n' : '\n'
  const B = splitLines(editedLF)
  const script = lineScript(
    lines.map(l => l.text),
    B.lines,
  )
  let out = ''
  let i = 0
  let j = 0
  for (const s of script) {
    if (s === '-') {
      i++
      continue
    }
    const isLast = j === B.lines.length - 1
    const end = isLast && !B.eol ? '' : s === ' ' && (lines[i]?.end ?? '') !== '' ? lines[i]!.end : usual
    out += B.lines[j]! + end
    if (s === ' ') i++
    j++
  }
  return out
}

const ENDINGS_LABEL: Record<Endings, string> = { none: 'no line breaks', lf: 'LF', crlf: 'CRLF', mixed: 'mixed CRLF/LF' }

/** Each line's ending, in order ('' for a last line with none). */
function endingList(text: string): string[] {
  const out: string[] = []
  for (const piece of text.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (piece === '') continue
    out.push(piece.endsWith('\r\n') ? 'CRLF' : piece.endsWith('\n') ? 'LF' : '')
  }
  return out
}

/** The diff of two file texts as saved: lines compared without CR, every line-ending change reported apart. */
export function describeChange(before: string, after: string): Diff {
  if (before === after) return diffOf('', '')
  const diff = diffOf(toLF(before), toLF(after))
  const from = endingsOf(before)
  const to = endingsOf(after)
  const notes = [...diff.notes]
  if (from !== to && from !== 'none' && to !== 'none') notes.push(`Line endings change from ${ENDINGS_LABEL[from]} to ${ENDINGS_LABEL[to]}.`)
  // Lines the diff shows as unchanged may still change their ending: name them.
  if (before.includes('\r') || after.includes('\r')) {
    const a = splitLines(toLF(before)).lines
    const b = splitLines(toLF(after)).lines
    const ea = endingList(before)
    const eb = endingList(after)
    const moved: number[] = []
    let i = 0
    let j = 0
    for (const s of lineScript(a, b)) {
      if (s === ' ') {
        if ((ea[i] ?? '') !== (eb[j] ?? '') && (ea[i] ?? '') !== '' && (eb[j] ?? '') !== '') moved.push(j + 1)
        i++
        j++
      } else if (s === '-') i++
      else j++
    }
    if (moved.length > 0 && !(from !== to && from !== 'mixed' && to !== 'mixed')) {
      const list = moved.slice(0, 12).join(', ')
      notes.push(`${moved.length} unchanged line${moved.length === 1 ? '' : 's'} change${moved.length === 1 ? 's' : ''} line ending (CRLF/LF): line${moved.length === 1 ? '' : 's'} ${list}${moved.length > 12 ? ', …' : ''}.`)
    }
    const lastA = ea[ea.length - 1] ?? ''
    const lastB = eb[eb.length - 1] ?? ''
    const plain = notes.indexOf('Adds a newline at the end of the file.')
    if (lastA === '' && lastB !== '' && plain >= 0) notes[plain] = `Adds a ${lastB} line break at the end of the file.`
  }
  if (diff.isSame && notes.length === 0) notes.push('Only invisible line-ending bytes differ.')
  return { ...diff, isSame: false, notes }
}

export function unitSize(u: DiffUnit): number {
  return u.kind === 'hunk' ? u.source.length : u.text.length + 80
}

/** Groups units into pages of at most `max` characters (every unit is far smaller than a page). */
export function pagesOf(units: DiffUnit[], max = DIFF_PAGE_MAX): DiffUnit[][] {
  const pages: DiffUnit[][] = []
  let cur: DiffUnit[] = []
  let size = 0
  for (const u of units) {
    const n = unitSize(u)
    if (cur.length > 0 && size + n > max) {
      pages.push(cur)
      cur = []
      size = 0
    }
    cur.push(u)
    size += n
  }
  if (cur.length > 0) pages.push(cur)
  return pages
}

// ---------------------------------------------------------------- edits Claude makes

export type EditOp = { old: string; neu: string; all: boolean }

/** Applies one Edit tool call's semantics to `text`; a string error when it would fail. */
export function applyEdit(text: string, op: EditOp): { text: string } | { error: string } {
  if (op.old === '') {
    return text === '' ? { text: op.neu } : { error: 'old_string is empty but the file is not.' }
  }
  if (op.old === op.neu) return { error: 'old_string and new_string are the same.' }
  // Claude often writes LF line breaks for a CRLF file: match them as the file has them.
  if (!text.includes(op.old) && text.includes('\r\n') && op.old.includes('\n') && !op.old.includes('\r')) {
    return applyEdit(text, { old: op.old.replace(/\n/g, '\r\n'), neu: op.neu.replace(/\r?\n/g, '\r\n'), all: op.all })
  }
  const parts = text.split(op.old)
  const count = parts.length - 1
  if (count === 0) return { error: 'old_string was not found in the file (as it stands with any pending proposal applied).' }
  if (count > 1 && !op.all) return { error: `old_string occurs ${count} times; give more context or set replace_all.` }
  if (op.all) return { text: parts.join(op.neu) }
  const at = text.indexOf(op.old)
  return { text: text.slice(0, at) + op.neu + text.slice(at + op.old.length) }
}

export function applyEdits(text: string, ops: readonly EditOp[]): { text: string } | { error: string } {
  let cur = text
  for (const op of ops) {
    const r = applyEdit(cur, op)
    if ('error' in r) return r
    cur = r.text
  }
  return { text: cur }
}

// ---------------------------------------------------------------- paths

/** macOS reaches the user's files through this firmlink as well; fold it away. */
const DATA_VOLUME = '/System/Volumes/Data'

/**
 * Where a tool's path argument points, by spelling alone: trims spaces, expands
 * `~`, joins a relative path to `cwd`, drops `.` and empty parts, resolves `..`
 * and folds the Data-volume firmlink.
 */
export function normalizePath(path: string, home: string, cwd = '/'): string {
  const trimmed = path.trim()
  const expanded = trimmed.replace(/^~(?=\/|$)/, home)
  const absolute = expanded.startsWith('/') ? expanded : `${cwd.replace(/\/$/, '')}/${expanded}`
  const out: string[] = []
  for (const part of absolute.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  const joined = `/${out.join('/')}`
  return joined.toLowerCase().startsWith(`${DATA_VOLUME.toLowerCase()}/`) ? joined.slice(DATA_VOLUME.length) : joined
}

/** macOS volumes are case-insensitive by default, so paths compare folded. */
export function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export function isInside(path: string, dir: string): boolean {
  const p = path.toLowerCase()
  const d = dir.toLowerCase().replace(/\/$/, '')
  return p === d || p.startsWith(`${d}/`)
}

const READ_ONLY_HEAD = /^\s*(cat|head|tail|less|more|wc|grep|egrep|fgrep|diff|cmp|ls|stat|file|md5|shasum|test)\s/
const WRITE_HINT =
  /[>;&|`\n\r]|\$\(|--pre|-exec|-delete|\b(tee|xargs|sed|awk|perl|python3?|ruby|node|deno|bun|dd|truncate|mv|cp|rm|rmdir|unlink|ln|install|rsync|open|osascript|chmod|chflags|chown|touch|vi|vim|nvim|nano|ed|ex|bash|sh|zsh|eval|source)\b/

/** A conservative read-only test: one read command on one line, with no redirection, chaining or program it could run. */
export function isReadOnlyCommand(command: string): boolean {
  return READ_ONLY_HEAD.test(command) && !WRITE_HINT.test(command)
}

/**
 * Whether a shell command names the global CLAUDE.md, its backups, or the
 * folder holding them with a destructive verb. Quotes and backslashes are
 * dropped first, so `"CLAUDE.md"` and `CLAUDE\.md` count. A courtesy check:
 * what it misses is caught after the call, when the file is compared.
 */
export function commandTouchesProtected(command: string, home: string, file: string, hist: string): boolean {
  const flat = command.replace(/["'\\]/g, '').toLowerCase()
  const name = file.slice(file.lastIndexOf('/') + 1).toLowerCase()
  const stem = name.replace(/\.[^.]*$/, '')
  const namesFile = flat.includes(name) || new RegExp(`${escapeRegExp(stem)}\\.(m|\\*|\\?|\\[)`).test(flat)
  const namesHist = flat.includes('claude-md-hist') || flat.includes(hist.toLowerCase())
  const dir = file.slice(0, file.lastIndexOf('/')).toLowerCase()
  const dirSpellings = [dir, dir.replace(home.toLowerCase(), '~'), dir.replace(home.toLowerCase(), '$home'), dir.replace(home.toLowerCase(), '${home}')]
  // The folder itself (`cd ~/.claude`, `rm -rf ~/.claude`), or a name right inside it that could be the file or
  // its backups; not a path deeper in it (`~/.claude/skills/...`), which is someone else's.
  const near = `(?=$|[\\s;&|)<>]|/+(?:\\.?/+)*(?:${escapeRegExp(stem)}|claude-md|[*?\\[]|$|[\\s;&|)<>]))`
  const namesDir = dirSpellings.some(d => new RegExp(`${escapeRegExp(d)}${near}`).test(flat))
  const destructive = /\b(rm|rmdir|mv|unlink|ln|chmod|chflags|chown|rsync)\b|-delete\b/.test(flat)
  // A project's own CLAUDE.md is not this file: the name counts only beside the home folder's spelling.
  return (namesFile && namesDir) || namesHist || (namesDir && destructive)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------- backups

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** A filesystem-safe UTC stamp that sorts in time order: 2026-11-18T16-58-03-123Z. */
export function stampOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}-${pad(d.getUTCMilliseconds(), 3)}Z`
}

export const BACKUP_RE = /^CLAUDE\.md\.(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-\d+)?\.md$/

/** The moment a backup's name records, or null for a file that is not one. */
export function backupTime(name: string): number | null {
  const m = BACKUP_RE.exec(name)
  if (m === null) return null
  const [, y, mo, d, h, mi, s, ms] = m
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms))
}

export function localTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
