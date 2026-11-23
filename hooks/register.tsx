import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Backup, Disk, Draft, FileStamp, Proposal, ProposalEdit, View } from '../types'
import {
  PANEL_MAX_BYTES,
  applyEdits,
  backupTime,
  chunksOf,
  commandTouchesProtected,
  describeChange,
  endingsOf,
  forDisplay,
  hasOddControls,
  isInside,
  isReadOnlyCommand,
  lineCount,
  localTime,
  normalizePath,
  pagesOf,
  restoreEndings,
  samePath,
  sizeLabel,
  stampOf,
  toLF,
  utf8Length,
} from './lib'
import type { Diff, DiffUnit } from './lib'

const PANE = 'claudemd'
const TOOL_NAME = 'propose_change'
const TOOL = `mcp__claudemd-panel__${TOOL_NAME}`
/** What one `$.fs.read` may copy into the mod: the most the mod can hold to put back. */
const MAX_READ = 4 * 1024 * 1024
const POLL_MS = 2_000
const HISTORY_PAGE = 15
const TYPE_DEBOUNCE_MS = 400
const LIMIT_LABEL = sizeLabel(PANEL_MAX_BYTES)

/** Tools that write a file named by a path argument. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** Tools that cannot change a file (or only wait on the person); every other call is checked after it runs. */
const UNWATCHED = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'AskUserQuestion', 'TodoWrite', 'EnterPlanMode', 'ExitPlanMode', 'Agent', 'Task'])

const VIEW0: View = {
  mode: 'view',
  part: 0,
  diffPage: 0,
  historyPage: 0,
  notice: null,
  noticeKind: null,
  conflictFor: null,
  restoreName: null,
  restoreText: null,
  restoreStamp: null,
  restoreCurrent: null,
  historyTotal: 0,
}

// Change a tag when that value's fields change: it declines what an earlier version stored.
const diskA = atom({ plugin: 'claudemd-panel', key: 'disk' } as const, null, { shape: 'disk-2' })
const draftA = atom({ plugin: 'claudemd-panel', key: 'draft' } as const, null, { shape: 'draft-2' })
const proposalA = atom({ plugin: 'claudemd-panel', key: 'proposal' } as const, null, { shape: 'proposal-1' })
const historyA = atom({ plugin: 'claudemd-panel', key: 'history' } as const, [], { shape: 'history-1' })
const viewA = atom({ plugin: 'claudemd-panel', key: 'view' } as const, VIEW0, { shape: 'view-3' })

type $T = EngineInterface
type Paths = { home: string; file: string; hist: string; shown: string; histShown: string }
/** The last version the person approved (or that was there when the mod first looked), held to put back. */
type Known = {
  exists: boolean
  text: string | null
  size: number
  mtimeMs: number
  isLink: boolean
  /** Where a linked CLAUDE.md led when approved: put back by re-pointing the link, never by writing through a moved one. */
  realPath: string | null
  /** A byte-exact copy in History, for an approved file the mod cannot hold as text. */
  copy: string | null
}
type Commit =
  | { ok: true; backup: string | null }
  | { ok: false; isConflict: true }
  | { ok: false; isConflict: false; isBusy: boolean; error: string }
type Expect = { kind: 'text'; base: string; baseExists: boolean } | { kind: 'stamp'; stamp: FileStamp }
type Staged = { ok: true } | { ok: false; error: string }
type After = { exists: boolean; text: string | null; isExact: boolean; isLink: boolean; realPath: string | null; isDir: boolean }
type HistorySnap = { dir: string; files: Map<string, string> }
type Made = { shown: string; abs: string }

const STAGED =
  'Not written. ~/.claude/CLAUDE.md is guarded by the claudemd-panel mod: your change is now shown to the user as a diff in the CLAUDE.md panel, with Accept and Reject. It is written only if they press Accept, and you will be told which they chose. Further Edit calls on the file are added to the same proposal. Do not try to write the file another way.'
const SHELL_REFUSED =
  'Refused by the claudemd-panel mod: this command names ~/.claude/CLAUDE.md, its backups or their folder, and is not a plain one-line read. Read the file with the Read tool; propose a change with Edit or Write on the file, or with the propose_change tool, and the user reviews it in the CLAUDE.md panel.'
const HISTORY_REFUSED =
  'Refused by the claudemd-panel mod: the claude-md-history folder holds the backups of CLAUDE.md and only the panel adds to it.'

// Module state: a reload starts it over, and each piece is re-read when needed.
let pathsMemo: Paths | null = null
let poll: { cancel: () => void } | null = null
let typed: { seq: number; value: string } | null = null
let typedTimer: { cancel: () => void } | null = null
let diffMemo: { a: string; b: string; diff: Diff } | null = null
/** The last field key used: keys only ever increase, so no surface keeps an old field's typing. */
let lastSeq = 0
let known: Known | null = null
/** Claude tool calls running now; while any runs, a change to the file is theirs to answer for. */
let inFlight = 0
/** The panel is writing: one write at a time, so a double press can't save twice. */
let writing = false
/** Resolves when the panel's write in progress has landed; a check after a call waits for it. */
let writeDone: Promise<void> | null = null
/** Accept or Reject is being carried out: the other waits. */
let deciding = false
/** Checks after calls run one at a time, so two calls never answer for one change. */
let checking: Promise<void> = Promise.resolve()
/** Backup names the panel wrote itself: never reported as someone else's addition. */
const madeByPanel = new Set<string>()
/** Entries of History held for the list (the folder may hold more). */
const HISTORY_KEEP = 300

// ------------------------------------------------------------ paths and reads

const paths = async ($: $T): Promise<Paths> => {
  if (pathsMemo !== null) return pathsMemo
  const home = (await $.env.get('HOME')) ?? ''
  // For testing against a sandbox file instead of the real one.
  const override = await $.env.get('CLAUDEMD_PANEL_FILE')
  const file = override !== undefined && override !== '' ? normalizePath(override, home) : `${home}/.claude/CLAUDE.md`
  const dir = file.slice(0, file.lastIndexOf('/'))
  const hist = `${dir}/claude-md-history`
  const tilde = (p: string) => (home !== '' && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p)
  pathsMemo = { home, file, hist, shown: tilde(file), histShown: tilde(hist) }
  return pathsMemo
}

const statOf = async ($: $T, path: string) => $.fs.stat(path).catch(() => undefined)

const readText = async ($: $T, path: string, size: number): Promise<string | null> =>
  size > MAX_READ ? null : $.fs.read(path).catch(() => null)

/** Whether `text` is exactly the file's bytes (a file that is not UTF-8 decodes with replacement characters). */
const isExactUtf8 = async ($: $T, path: string, text: string): Promise<boolean> => {
  if (!text.includes('�')) return true
  try {
    const raw = await $.fs.read(path, { as: 'bytes' })
    const b64 = typeof raw === 'string' ? raw : raw.base64
    const bytes = (Uint8Array as unknown as { fromBase64: (s: string) => Uint8Array }).fromBase64(b64)
    const again = new TextEncoder().encode(text)
    if (bytes.length !== again.length) return false
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== again[i]) return false
    return true
  } catch {
    return false
  }
}

const absent = (): Disk => ({ exists: false, text: '', size: 0, mtimeMs: 0, isTooLarge: false, isNotUtf8: false, error: null })

/** Whether what is on disk may become the approved version now: never while a Claude call runs or the panel writes. */
const mayRebase = () => known === null || (inFlight === 0 && !writing)

const realPathOf = async ($: $T, path: string): Promise<string | null> => (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath ?? null

/**
 * Reads the file as it is now. While no Claude call runs (or with `rebase`),
 * what it read becomes the approved version: the one put back after a call.
 */
const readFresh = async ($: $T, rebase = mayRebase()): Promise<Disk> => {
  const P = await paths($)
  const st = await statOf($, P.file)
  if (st === undefined) {
    if (rebase) known = { exists: false, text: '', size: 0, mtimeMs: 0, isLink: false, realPath: null, copy: null }
    return absent()
  }
  const realPath = st.isLink ? await realPathOf($, P.file) : null
  const keepCopy = known !== null && known.copy !== null && known.size === st.size && known.mtimeMs === st.mtimeMs ? known.copy : null
  const base: Disk = { exists: true, text: '', size: st.size, mtimeMs: st.mtimeMs, isTooLarge: false, isNotUtf8: false, error: null }
  if (st.kind !== 'file') {
    if (rebase) known = { exists: true, text: null, size: st.size, mtimeMs: st.mtimeMs, isLink: st.isLink, realPath, copy: null }
    return { ...base, error: `${P.shown} is not a regular file.` }
  }
  const text = await readText($, P.file, st.size)
  const isExact = text !== null && (await isExactUtf8($, P.file, text))
  if (rebase) known = { exists: true, text: isExact ? text : null, size: st.size, mtimeMs: st.mtimeMs, isLink: st.isLink, realPath, copy: isExact ? null : keepCopy }
  if (st.size > PANEL_MAX_BYTES) return { ...base, isTooLarge: true }
  if (text === null) return { ...base, error: `Could not read ${P.shown}.` }
  if (!isExact) return { ...base, isNotUtf8: true }
  return { ...base, text }
}

const sameDisk = (a: Disk, b: Disk) =>
  a.exists === b.exists &&
  a.text === b.text &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.isTooLarge === b.isTooLarge &&
  a.isNotUtf8 === b.isNotUtf8 &&
  a.error === b.error

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ------------------------------------------------------------ backups

const listHistory = async ($: $T): Promise<HistorySnap> => {
  const P = await paths($)
  const st = await statOf($, P.hist)
  const dir = st === undefined ? 'none' : st.isLink ? `link:${(await realPathOf($, P.hist)) ?? '?'}` : st.kind
  const entries = await $.fs.list(P.hist).catch(() => [])
  return { dir, files: new Map(entries.filter(e => e.kind === 'file').map(e => [e.name, `${e.size}:${e.mtimeMs}`])) }
}

/** Lists the backups, newest first; the panel holds the newest few hundred. */
const refreshHistory = async ($: $T): Promise<Backup[]> => {
  const P = await paths($)
  const entries = await $.fs.list(P.hist).catch(() => [])
  const suffix = (name: string) => Number(/Z-(\d+)\.md$/.exec(name)?.[1] ?? '1')
  const list: Backup[] = entries
    .filter(entry => entry.kind === 'file' && backupTime(entry.name) !== null)
    .map(entry => ({ name: entry.name, size: entry.size, at: backupTime(entry.name) ?? 0 }))
    .sort((a, b) => b.at - a.at || suffix(b.name) - suffix(a.name))
  await update($, historyA, () => list.slice(0, HISTORY_KEEP))
  await setView($, { historyTotal: list.length })
  return list
}

/** A new, never-reused backup name; recorded as the panel's own. */
const newBackupName = async ($: $T): Promise<Made> => {
  const P = await paths($)
  const stamp = stampOf(await $.clock.now())
  let name = `CLAUDE.md.${stamp}.md`
  for (let n = 2; madeByPanel.has(name) || (await $.fs.exists(`${P.hist}/${name}`)); n++) name = `CLAUDE.md.${stamp}-${n}.md`
  madeByPanel.add(name)
  return { shown: `${P.histShown}/${name}`, abs: `${P.hist}/${name}` }
}

/** Writes `text` as a new backup and reads it back. */
const writeBackup = async ($: $T, text: string): Promise<Made> => {
  const made = await newBackupName($)
  await $.fs.write(made.abs, text)
  if ((await $.fs.read(made.abs)) !== text) throw new Error('the backup did not read back the same')
  return made
}

/** Copies the file into History byte for byte (any size, any bytes), and compares the copy. */
const copyBackup = async ($: $T): Promise<Made> => {
  const P = await paths($)
  const made = await newBackupName($)
  await $.process.run(['/bin/mkdir', '-p', P.hist])
  const copied = await $.process.run(['/bin/cp', '-p', P.file, made.abs])
  if (copied.exitCode !== 0) throw new Error('the copy failed')
  const same = await $.process.run(['/usr/bin/cmp', '-s', P.file, made.abs])
  if (same.exitCode !== 0) throw new Error('the copy did not compare the same')
  return made
}

/** Keeps a version in History unless the newest backup already holds it; whether it is there now. */
const keepVersion = async ($: $T, text: string): Promise<boolean> => {
  const P = await paths($)
  const newest = (await refreshHistory($))[0]
  if (newest !== undefined && (await $.fs.read(`${P.hist}/${newest.name}`).catch(() => null)) === text) return true
  const made = await writeBackup($, text).catch(() => null)
  await refreshHistory($)
  return made !== null
}

/** For an approved file the mod cannot hold as text (over 4 MiB, or not UTF-8), keeps a byte-exact copy to put back. */
const ensureCopy = async ($: $T) => {
  const k = known
  if (k === null || !k.exists || k.text !== null || k.copy !== null) return
  const P = await paths($)
  const st = await statOf($, P.file)
  if (st === undefined || st.kind !== 'file') return
  const newest = (await refreshHistory($))[0]
  if (newest !== undefined) {
    const same = await $.process.run(['/usr/bin/cmp', '-s', P.file, `${P.hist}/${newest.name}`]).catch(() => undefined)
    if (same?.exitCode === 0) {
      known = { ...k, copy: `${P.hist}/${newest.name}` }
      return
    }
  }
  const made = await copyBackup($).catch(() => null)
  if (made !== null) known = { ...k, copy: made.abs }
  await refreshHistory($)
}

// ------------------------------------------------------------ the pane

const setView = ($: $T, patch: Partial<View>) => update($, viewA, v => ({ ...v, ...patch }))

const notify = ($: $T, notice: string, noticeKind: View['noticeKind']) => setView($, { notice, noticeKind })

/** A row the model reads on its next request; the person does not see it as typed. */
const tellClaude = async ($: $T, text: string) => {
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `[claudemd-panel] ${text}` }] } }).catch(() => undefined)
}

/** Keeps the version an outside edit replaced, and says so (or says that it could not). */
const noteOutside = async ($: $T, before: Known | null) => {
  const P = await paths($)
  if (before === null || !before.exists) return
  if (before.text !== null && before.text === known?.text) return
  const kept = before.text !== null ? await keepVersion($, before.text) : before.copy !== null
  await notify(
    $,
    kept ? `${P.shown} was changed outside the panel. The version before that is kept in History.` : `${P.shown} was changed outside the panel, and the version before could NOT be saved to History.`,
    kept ? 'warn' : 'error',
  )
}

/**
 * Re-reads the file when its size, time or (for a file the panel shows) its
 * text moved, or always with `force`. A change the poll finds while no Claude
 * call runs is someone else's edit: it is kept, and the version it replaced
 * is kept in History first.
 */
const refreshDisk = async ($: $T, force = false, isPoll = false): Promise<Disk | null> => {
  const cur = await read($, diskA)
  const P = await paths($)
  if (!force && cur !== null) {
    const st = await statOf($, P.file)
    if (st === undefined && !cur.exists) return cur
    if (st !== undefined && cur.exists && st.mtimeMs === cur.mtimeMs && st.size === cur.size) {
      // The same size and time can still hide new text: compare it where the panel holds the text.
      if (!isPoll || cur.isTooLarge || cur.isNotUtf8 || cur.error !== null) return cur
      const now = await $.fs.read(P.file).catch(() => null)
      if (now === null || now === cur.text) return cur
    }
  }
  if (isPoll && (inFlight > 0 || writing)) return cur
  const before = known
  const fresh = await readFresh($)
  if (cur === null || !sameDisk(cur, fresh)) {
    if (isPoll && cur !== null) await noteOutside($, before)
    await update($, diskA, () => fresh)
  }
  return fresh
}

const startPolling = ($: $T) => {
  if (poll !== null) return
  poll = $.clock.every(POLL_MS, () => {
    void refreshDisk($, false, true).catch(() => undefined)
  })
}

const openPane = async ($: $T) => {
  const opened = await $.ui.open({ id: PANE, title: 'CLAUDE.md' })
  startPolling($)
  await refreshDisk($, true)
  await refreshHistory($)
  return opened
}

// ------------------------------------------------------------ writing, always through here

/**
 * The one place the panel writes the file. It re-reads the file and refuses
 * when it is no longer what the change was made against, backs the current
 * version up, looks once more, writes, and reads back.
 */
const commitWrite = async ($: $T, out: string, expect: Expect): Promise<Commit> => {
  if (writing) return { ok: false, isConflict: false, isBusy: true, error: '' }
  writing = true
  let release = () => {}
  writeDone = new Promise<void>(resolve => {
    release = resolve
  })
  try {
    const P = await paths($)
    const fail = (error: string): Commit => ({ ok: false, isConflict: false, isBusy: false, error })
    if (utf8Length(out) > PANEL_MAX_BYTES) return fail(`Not saved: the new text is over the panel's ${LIMIT_LABEL} limit.`)
    const st = await statOf($, P.file)
    if (st !== undefined && st.kind !== 'file') return fail(`Not saved: ${P.shown} is not a regular file.`)
    const current = st === undefined ? '' : await readText($, P.file, st.size)
    // Too large to read: it can still be backed up byte for byte, and judged by its size and time.
    const isHuge = st !== undefined && current === null && st.size > MAX_READ
    if (current === null && !isHuge) return fail(`Not saved: ${P.shown} could not be read, so it could not be backed up first.`)
    const isMoved =
      expect.kind === 'text'
        ? (st !== undefined) !== expect.baseExists || (st !== undefined && current !== expect.base)
        : (st !== undefined) !== expect.stamp.exists || (st !== undefined && (st.size !== expect.stamp.size || st.mtimeMs !== expect.stamp.mtimeMs))
    if (isMoved) {
      await refreshDisk($, true)
      return { ok: false, isConflict: true }
    }
    let backup: string | null = null
    if (st !== undefined) {
      try {
        const made = current !== null && (await isExactUtf8($, P.file, current)) ? await writeBackup($, current) : await copyBackup($)
        backup = made.shown
      } catch (err) {
        return fail(`Not saved: the backup could not be written (${errText(err)}).`)
      }
    }
    // One more look: did anything write the file while the backup was made?
    const again = await statOf($, P.file)
    if ((again === undefined) !== (st === undefined) || (again !== undefined && st !== undefined && (again.size !== st.size || again.mtimeMs !== st.mtimeMs))) {
      await refreshDisk($, true)
      return { ok: false, isConflict: true }
    }
    const resolved = st?.isLink ? (await $.fs.stat(P.file, { resolve: true }).catch(() => undefined))?.realPath : undefined
    // Approved before it lands, so no check running alongside takes it for Claude's.
    known = { exists: true, text: out, size: -1, mtimeMs: -1, isLink: st?.isLink ?? false, realPath: resolved ?? null, copy: null }
    try {
      await $.fs.write(resolved ?? P.file, out)
    } catch (err) {
      await readFresh($, true)
      return fail(`Not saved: ${errText(err)}.`)
    }
    const check = await $.fs.read(P.file).catch(() => null)
    const landed = await statOf($, P.file)
    if (landed !== undefined && check === out) known = { ...known, size: landed.size, mtimeMs: landed.mtimeMs }
    await refreshDisk($, true)
    await refreshHistory($)
    if (check !== out) return fail(`Written, but it did not read back the same. Check ${P.shown}; the version before is in History.`)
    return { ok: true, backup }
  } finally {
    writing = false
    writeDone = null
    release()
  }
}

const savedNote = (backup: string | null) => (backup === null ? ' (There was no earlier version to back up.)' : ` The version before is backed up at ${backup}.`)

// ------------------------------------------------------------ the person's own edit

const isUnchanged = (d: Draft) => d.text === toLF(d.base)

/** What saving the draft writes: unchanged lines keep their own line endings, new ones take the file's usual one. */
const draftOut = (d: Draft) => restoreEndings(d.base, d.text)

/** Folds what was typed into the draft (typing is held briefly so a large file is not rewritten per key). */
const flushTyped = async ($: $T) => {
  typedTimer?.cancel()
  typedTimer = null
  const pending = typed
  typed = null
  if (pending === null) return
  await update($, draftA, d =>
    d === null || d.seq !== pending.seq
      ? d
      : { ...d, text: d.text.slice(0, d.partStart) + pending.value + d.text.slice(d.partEnd), partEnd: d.partStart + pending.value.length },
  )
}

const onType = ($: $T, seq: number, value: string) => {
  typed = { seq, value }
  typedTimer?.cancel()
  typedTimer = $.clock.after(TYPE_DEBOUNCE_MS, () => {
    void flushTyped($)
  })
}

const startEdit = async ($: $T, part?: number) => {
  await flushTyped($)
  const disk = await refreshDisk($, true)
  if (disk === null) return
  if (disk.isTooLarge || disk.isNotUtf8 || disk.error !== null) {
    await notify(
      $,
      disk.error ?? (disk.isTooLarge ? `The file is over the panel's ${LIMIT_LABEL} limit. Open it in your editor instead.` : 'The file is not UTF-8 text. Open it in your editor instead.'),
      'warn',
    )
    return
  }
  if (hasOddControls(disk.text)) {
    await notify($, 'The file holds control characters the panel cannot edit safely. Open it in your editor instead.', 'warn')
    return
  }
  const view = await read($, viewA)
  let existing = await read($, draftA)
  // An untouched draft follows the file: drop it when the file moved on.
  if (existing !== null && isUnchanged(existing) && (existing.base !== disk.text || existing.baseExists !== disk.exists)) existing = null
  const d: Draft = existing ?? {
    base: disk.text,
    baseExists: disk.exists,
    text: toLF(disk.text),
    endings: endingsOf(disk.text),
    partStart: 0,
    partEnd: 0,
    fieldStart: '',
    seq: 0,
  }
  const parts = chunksOf(d.text)
  const i = Math.max(0, Math.min(part ?? view.part, parts.length - 1))
  const chosen = parts[i] ?? { start: 0, end: d.text.length, label: '' }
  const seq = Math.max(d.seq + 1, lastSeq + 1, await $.clock.now())
  lastSeq = seq
  await update($, draftA, () => ({ ...d, partStart: chosen.start, partEnd: chosen.end, fieldStart: d.text.slice(chosen.start, chosen.end), seq }))
  await setView($, { mode: 'edit', part: i, notice: null, noticeKind: null })
}

const leaveEdit = async ($: $T) => {
  await flushTyped($)
  await update($, draftA, d => (d !== null && isUnchanged(d) ? null : d))
  await setView($, { mode: 'view' })
}

const reviewDraft = async ($: $T) => {
  await flushTyped($)
  await setView($, { mode: 'review', diffPage: 0, notice: null, noticeKind: null })
}

const discardDraft = async ($: $T) => {
  typedTimer?.cancel()
  typedTimer = null
  typed = null
  await update($, draftA, () => null)
  await setView($, { mode: 'view', notice: 'Discarded your unsaved changes. The file was not changed.', noticeKind: 'ok' })
}

const saveDraft = async ($: $T) => {
  await flushTyped($)
  const d = await read($, draftA)
  if (d === null) return
  const result = await commitWrite($, draftOut(d), { kind: 'text', base: d.base, baseExists: d.baseExists })
  if (result.ok) {
    await update($, draftA, () => null)
    await setView($, { mode: 'view', notice: `Saved.${savedNote(result.backup)}`, noticeKind: 'ok' })
  } else if (result.isConflict) {
    await setView($, { mode: 'conflict', conflictFor: 'draft', diffPage: 0, notice: null, noticeKind: null })
  } else if (!result.isBusy) {
    await notify($, result.error, 'error')
  }
}

// ------------------------------------------------------------ Claude's proposals

const stageProposal = async ($: $T, change: { text?: string; edits?: ProposalEdit[]; summary: string; source: string }): Promise<Staged> => {
  const P = await paths($)
  if (inFlight === 0 && !writing) await settleKnown($)
  if (known === null) await readFresh($, true)
  const disk = await readFresh($, false)
  await update($, diskA, () => disk)
  const k = known
  if (k === null) return { ok: false, error: `Could not read ${P.shown}.` }
  if (k.exists && k.text === null) {
    return {
      ok: false,
      error: k.size > PANEL_MAX_BYTES ? `${P.shown} is over the panel's ${LIMIT_LABEL} limit, so changes to it can't be reviewed there. Ask the user to edit it themselves.` : `${P.shown} is not UTF-8 text, or not a readable file. Ask the user to edit it themselves.`,
    }
  }
  const approved = k.exists ? (k.text ?? '') : ''
  if (utf8Length(approved) > PANEL_MAX_BYTES) return { ok: false, error: `${P.shown} is over the panel's ${LIMIT_LABEL} limit, so changes to it can't be reviewed there. Ask the user to edit it themselves.` }
  const cur = await read($, proposalA)
  const from = cur === null ? approved : cur.text
  let text: string
  if (change.edits !== undefined) {
    const applied = applyEdits(from, change.edits)
    if ('error' in applied) return { ok: false, error: applied.error }
    text = applied.text
  } else {
    text = change.text ?? ''
  }
  if (utf8Length(text) > PANEL_MAX_BYTES) return { ok: false, error: `the proposed text is over the panel's ${LIMIT_LABEL} limit.` }
  const base = cur === null ? approved : cur.base
  if (cur === null && text === base && k.exists) return { ok: false, error: 'That is exactly what the file already holds, so there is nothing to review.' }
  const now = await $.clock.now()
  const summary = [cur?.summary ?? '', change.summary].filter(s => s.trim() !== '').join(' · ')
  const next: Proposal =
    cur === null
      ? { id: `p${now}`, base, baseExists: k.exists, text, summary, source: change.source, createdAt: now, edits: change.edits ?? null }
      : {
          ...cur,
          text,
          summary,
          source: cur.source === change.source ? cur.source : `${cur.source} + ${change.source}`,
          edits: cur.edits !== null && change.edits !== undefined ? [...cur.edits, ...change.edits] : null,
        }
  await update($, proposalA, () => next)
  await setView($, { mode: 'proposal', diffPage: 0, notice: null, noticeKind: null })
  const opened = await openPane($).catch(() => undefined)
  $.ui.status('CLAUDE.md: a proposed change awaits your review (/claudemd)')
  if (opened === undefined || !opened.isPlaced) $.ui.toast('Claude proposed a change to CLAUDE.md. Run /claudemd to review it.')
  return { ok: true }
}

/** Turns an Edit, Write or MultiEdit call on the file into a proposal; the refusal Claude reads. */
const stageFromTool = async ($: $T, tool: string, input: Record<string, unknown>): Promise<string> => {
  try {
    let staged: Staged
    if (tool === 'Write') {
      staged = await stageProposal($, { text: String(input.content ?? ''), summary: '', source: 'Write' })
    } else if (tool === 'Edit') {
      staged = await stageProposal($, {
        edits: [{ old: String(input.old_string ?? ''), neu: String(input.new_string ?? ''), all: input.replace_all === true }],
        summary: '',
        source: 'Edit',
      })
    } else if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
      const edits = (input.edits as Array<Record<string, unknown>>).map(one => ({ old: String(one.old_string ?? ''), neu: String(one.new_string ?? ''), all: one.replace_all === true }))
      staged = await stageProposal($, { edits, summary: '', source: 'MultiEdit' })
    } else {
      return 'Refused by the claudemd-panel mod: ~/.claude/CLAUDE.md is changed only through the CLAUDE.md panel.'
    }
    return staged.ok ? STAGED : `Not staged, and not written: ${staged.error}`
  } catch (err) {
    return `Not staged, and not written: ${errText(err)}`
  }
}

/** Serves the tool Claude calls to propose a whole new text. */
const serveTool = async ($: $T, input: { content?: unknown; summary?: unknown }) => {
  if (typeof input.content !== 'string') return { result: 'Not staged: `content`, the complete new file text, is required.' }
  try {
    const staged = await stageProposal($, { text: input.content, summary: typeof input.summary === 'string' ? input.summary : '', source: 'propose_change' })
    return {
      result: staged.ok
        ? 'Shown to the user as a diff in the CLAUDE.md panel. Nothing is written unless they press Accept; you will be told their decision.'
        : `Not staged: ${staged.error}`,
    }
  } catch (err) {
    return { result: `Not staged: ${errText(err)}` }
  }
}

const acceptProposal = async ($: $T) => {
  if (deciding) return
  deciding = true
  try {
    await acceptNow($)
  } finally {
    deciding = false
  }
}

const acceptNow = async ($: $T) => {
  const p = await read($, proposalA)
  if (p === null) return
  const P = await paths($)
  const result = await commitWrite($, p.text, { kind: 'text', base: p.base, baseExists: p.baseExists })
  if (result.ok) {
    // Claude may have added to the proposal while it was being written: keep what came after.
    let hasMore = false
    await update($, proposalA, cur => {
      hasMore = cur !== null && !(cur.id === p.id && cur.text === p.text)
      if (cur === null || !hasMore) return null
      return { ...cur, base: p.text, baseExists: true, edits: cur.edits !== null && p.edits !== null ? cur.edits.slice(p.edits.length) : null }
    })
    if (!hasMore) $.ui.status(undefined)
    await setView($, {
      mode: hasMore ? 'proposal' : 'view',
      diffPage: 0,
      notice: `Accepted and saved.${savedNote(result.backup)}${hasMore ? ' Claude proposed more since; it is shown below.' : ''}`,
      noticeKind: 'ok',
    })
    await tellClaude(
      $,
      `The user ACCEPTED your proposed change to ${P.shown}, and it is saved.${result.backup === null ? '' : ` The previous version is backed up at ${result.backup}.`}${hasMore ? ' Your later edits are still pending their review.' : ''} CLAUDE.md is read when a session starts, so new sessions pick it up.`,
    )
  } else if (result.isConflict) {
    await setView($, { mode: 'conflict', conflictFor: 'proposal', diffPage: 0, notice: null, noticeKind: null })
  } else if (!result.isBusy) {
    await notify($, result.error, 'error')
  }
}

const rejectProposal = async ($: $T) => {
  if (deciding || writing) return
  deciding = true
  try {
    await rejectNow($)
  } finally {
    deciding = false
  }
}

const rejectNow = async ($: $T) => {
  const p = await read($, proposalA)
  if (p === null) return
  const P = await paths($)
  await update($, proposalA, () => null)
  $.ui.status(undefined)
  await setView($, { mode: 'view', notice: 'Rejected. The file was not changed.', noticeKind: 'ok' })
  await tellClaude($, `The user REJECTED your proposed change to ${P.shown}. The file was not changed. Do not try to write it another way.`)
}

// ------------------------------------------------------------ when the file changed underneath

const rebaseOnDisk = async ($: $T) => {
  const disk = await refreshDisk($, true)
  if (disk === null) return
  const view = await read($, viewA)
  if (view.conflictFor === 'draft') {
    await update($, draftA, d => (d === null ? d : { ...d, base: disk.text, baseExists: disk.exists, endings: endingsOf(disk.text) }))
    await setView($, { mode: 'review', conflictFor: null, diffPage: 0, notice: 'Now showing your draft against the file as it is on disk. Saving replaces it, outside changes included.', noticeKind: 'warn' })
  } else {
    await update($, proposalA, p => (p === null ? p : { ...p, base: disk.text, baseExists: disk.exists }))
    await setView($, { mode: 'proposal', conflictFor: null, diffPage: 0, notice: 'Now showing Claude’s version against the file as it is on disk. Accepting replaces it, outside changes included.', noticeKind: 'warn' })
  }
}

const reapplyEdits = async ($: $T) => {
  const p = await read($, proposalA)
  if (p === null || p.edits === null) return
  const disk = await refreshDisk($, true)
  if (disk === null) return
  const applied = applyEdits(disk.text, p.edits)
  if ('error' in applied) {
    await notify($, `Claude’s edits do not apply to the current file: ${applied.error}`, 'error')
    return
  }
  await update($, proposalA, () => ({ ...p, base: disk.text, baseExists: disk.exists, text: applied.text }))
  await setView($, { mode: 'proposal', conflictFor: null, diffPage: 0, notice: 'Re-applied Claude’s edits to the current file. Review the diff again.', noticeKind: 'ok' })
}

// ------------------------------------------------------------ the check after every Claude tool call

/** Settles a change made while no Claude call ran (an outside edit) as the approved version, keeping the one before. */
const settleKnown = async ($: $T) => {
  if (known === null) {
    await readFresh($, true)
    await ensureCopy($)
    return
  }
  if (inFlight > 0 || writing) return
  await refreshDisk($, false, true)
  await ensureCopy($)
}

/** How the file differs from the approved version now (by content, not only size and time), or null. */
const changeSinceKnown = async ($: $T): Promise<After | null> => {
  const P = await paths($)
  const k = known
  if (k === null) return null
  const st = await statOf($, P.file)
  if (st === undefined) return k.exists ? { exists: false, text: null, isExact: false, isLink: false, realPath: null, isDir: false } : null
  if (st.kind === 'dir') return { exists: true, text: null, isExact: false, isLink: st.isLink, realPath: null, isDir: true }
  const realPath = st.isLink ? await realPathOf($, P.file) : null
  const isLinkSame = st.isLink === k.isLink && (!st.isLink || realPath === k.realPath)
  const text = await readText($, P.file, st.size)
  if (k.exists && isLinkSame) {
    let isSame = false
    if (k.text !== null) isSame = text === k.text
    else if (k.copy !== null) isSame = (await $.process.run(['/usr/bin/cmp', '-s', P.file, k.copy]).catch(() => undefined))?.exitCode === 0
    else isSame = st.size === k.size && st.mtimeMs === k.mtimeMs
    if (isSame) {
      known = { ...k, size: st.size, mtimeMs: st.mtimeMs }
      return null
    }
  }
  const isExact = text !== null && (await isExactUtf8($, P.file, text))
  return { exists: true, text, isExact, isLink: st.isLink, realPath, isDir: false }
}

const removeFile = async ($: $T, path: string) => {
  await $.process.run(['/bin/rm', '-f', path]).catch(() => undefined)
}

/** Writes the approved content at `path` unless it is already there. */
const putContent = async ($: $T, k: Known, path: string) => {
  if (k.text !== null) {
    if ((await $.fs.read(path).catch(() => null)) !== k.text) await $.fs.write(path, k.text)
  } else if (k.copy !== null) {
    await $.process.run(['/bin/cp', '-p', k.copy, path])
  }
}

/**
 * After a Claude call changed the file: keeps what the call left (byte for
 * byte, in History), puts the approved version back (re-pointing a moved link
 * rather than writing through it), and offers the call's text as a proposal.
 */
const undoCallWrite = async ($: $T, tool: string, after: After) => {
  const P = await paths($)
  const k = known
  if (k === null) return
  const isRepointed = after.exists && after.isLink && k.isLink && after.realPath !== k.realPath
  const isLinkMoved = after.exists && !after.isDir && (after.isLink !== k.isLink || isRepointed)
  const what = !after.exists ? 'deleted' : after.isDir ? 'replaced with a folder' : isRepointed ? `re-pointed (to ${after.realPath ?? 'another file'})` : 'changed'
  // 1. What the call left in the file's place is never lost (another file a moved link names is left alone).
  const kept = after.exists && !after.isDir && !isRepointed ? await copyBackup($).catch(() => null) : null
  // 2. Put the approved version back.
  const canPut = !k.exists || k.text !== null || k.copy !== null
  if (canPut) {
    if (after.isDir) await $.process.run(['/bin/mv', P.file, `${P.file}.moved-aside-${stampOf(await $.clock.now())}`]).catch(() => undefined)
    else if (isLinkMoved) await removeFile($, P.file)
    try {
      if (!k.exists) {
        await removeFile($, P.file)
      } else if (k.isLink && k.realPath !== null) {
        if (isLinkMoved || after.isDir || !after.exists) await $.process.run(['/bin/ln', '-sfn', k.realPath, P.file])
        await putContent($, k, k.realPath)
      } else {
        await putContent($, k, P.file)
      }
    } catch {
      // judged below by reading the file again
    }
  }
  const isBack = canPut && (await changeSinceKnown($)) === null
  // Never lose the approved version: when it could not be put back, it goes to History.
  if (!isBack && k.exists && k.text !== null) await keepVersion($, k.text)
  await refreshDisk($, true)
  await refreshHistory($)
  // 3. Offer the call's text as a proposal, unless another proposal is waiting (it is in History either way).
  let offered = false
  if (isBack && after.exists && !after.isDir && !isRepointed && after.isExact && after.text !== null && after.text !== (k.text ?? '') && utf8Length(after.text) <= PANEL_MAX_BYTES && (await read($, proposalA)) === null) {
    const staged = await stageProposal($, {
      text: after.text,
      summary: `Written by Claude’s ${tool} call outside the panel, and undone. If it was your own edit made while Claude was working, Accept it.`,
      source: `${tool} (undone)`,
    }).catch(() => ({ ok: false as const, error: '' }))
    offered = staged.ok
  }
  const keptNote = kept !== null ? ` What it left is kept at ${kept.shown}.` : ''
  if (isBack) {
    $.ui.toast(`Claude’s ${tool} call ${what} CLAUDE.md. The approved version was put back.`)
    if (!offered) await notify($, `Claude’s ${tool} call ${what} ${P.shown}. The approved version was put back.${keptNote}`, 'warn')
    await tellClaude($, `Your ${tool} call ${what} ${P.shown} outside the CLAUDE.md panel. The mod put the approved version back${offered ? ' and showed your version to the user as a proposal (Accept or Reject)' : ''}.${keptNote} Only the user changes that file: propose changes with Edit or Write on it, or with propose_change.`)
  } else {
    $.ui.status(`CLAUDE.md was ${what} by Claude's ${tool} call and could not be put back`)
    await notify($, `Claude’s ${tool} call ${what} ${P.shown}, and the approved version could not be put back.${keptNote} Check the file; History holds earlier versions.`, 'error')
    await tellClaude($, `Your ${tool} call ${what} ${P.shown} outside the CLAUDE.md panel. Only the user changes that file.`)
  }
}

const reportHistory = async ($: $T, tool: string, before: HistorySnap, after: HistorySnap) => {
  const P = await paths($)
  const lost = [...before.files].filter(([name, sig]) => after.files.get(name) !== sig).map(([name]) => name)
  const added = [...after.files.keys()].filter(name => !before.files.has(name) && !madeByPanel.has(name))
  // The panel making the folder for its first backup is no tampering; anything else that swaps it is.
  const isMoved = before.dir !== after.dir && !(before.dir === 'none' && after.dir === 'dir')
  if (lost.length === 0 && added.length === 0 && !isMoved) return
  await refreshHistory($)
  const parts = [
    lost.length > 0 ? `removed or changed backups (${lost.length}: ${lost.slice(0, 3).join(', ')}${lost.length > 3 ? ', …' : ''}), which can no longer be restored from here` : '',
    added.length > 0 ? `added ${added.length} file${added.length === 1 ? '' : 's'} among the backups that the panel did not write (${added.slice(0, 3).join(', ')}${added.length > 3 ? ', …' : ''}); don't trust them` : '',
    isMoved ? `replaced the backups folder itself (${before.dir} → ${after.dir})` : '',
  ].filter(x => x !== '')
  $.ui.status(`Claude's ${tool} call tampered with CLAUDE.md backups`)
  await notify($, `Claude’s ${tool} call ${parts.join('; ')} in ${P.histShown}.`, 'error')
  await tellClaude($, `Your ${tool} call ${parts.join('; ')} in ${P.histShown}. That backups folder belongs to the user's CLAUDE.md panel; never touch it.`)
}

/** Runs one check after another, never two at once. */
const serially = (fn: () => Promise<void>): Promise<void> => {
  const run = checking.then(fn, fn)
  checking = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Runs a Claude tool call, then checks the file and its backups against what was there before. */
const watchCall = async <R,>($: $T, tool: string, run: () => Promise<R>): Promise<R> => {
  await settleKnown($).catch(() => undefined)
  const histBefore = await listHistory($).catch(() => null)
  inFlight++
  let didRun = true
  try {
    const ran = await run()
    // A call the engine refused (a denied permission, say) did not run: a change meanwhile is not its doing.
    didRun = !(typeof ran === 'object' && ran !== null && (ran as { deny?: unknown }).deny !== undefined)
    return ran
  } finally {
    await serially(async () => {
      try {
        while (writeDone !== null) await writeDone
        const after = await changeSinceKnown($)
        if (after !== null) {
          if (didRun) {
            await undoCallWrite($, tool, after)
          } else {
            const before = known
            await readFresh($, true)
            await noteOutside($, before)
            await refreshDisk($, true)
          }
        }
        if (histBefore !== null) await reportHistory($, tool, histBefore, await listHistory($))
      } catch {
        // The call's own result stands; the poll keeps watching the file.
      }
    }).catch(() => undefined)
    inFlight--
  }
}

// ------------------------------------------------------------ history

const openRestore = async ($: $T, name: string) => {
  const P = await paths($)
  const disk = await refreshDisk($, true)
  const st = await statOf($, `${P.hist}/${name}`)
  if (st === undefined) {
    await notify($, 'That backup is gone.', 'error')
    await refreshHistory($)
    return
  }
  if (st.size > PANEL_MAX_BYTES) {
    await notify($, `That backup is over the panel's ${LIMIT_LABEL} limit, so it can't be restored from here. Copy it over the file yourself if you need it.`, 'warn')
    return
  }
  const text = await $.fs.read(`${P.hist}/${name}`).catch(() => null)
  if (text === null) {
    await notify($, 'Could not read that backup.', 'error')
    return
  }
  const cur = await statOf($, P.file)
  await setView($, {
    mode: 'restore',
    diffPage: 0,
    restoreName: name,
    restoreText: text,
    restoreStamp: { exists: cur !== undefined, size: cur?.size ?? 0, mtimeMs: cur?.mtimeMs ?? 0 },
    restoreCurrent: disk !== null && !disk.isTooLarge && !disk.isNotUtf8 && disk.error === null ? disk.text : null,
    notice: null,
    noticeKind: null,
  })
}

const restoreChosen = async ($: $T) => {
  const view = await read($, viewA)
  if (view.restoreText === null || view.restoreStamp === null) return
  const result = await commitWrite($, view.restoreText, { kind: 'stamp', stamp: view.restoreStamp })
  if (result.ok) {
    const at = view.restoreName === null ? null : backupTime(view.restoreName)
    await setView($, {
      mode: 'view',
      restoreName: null,
      restoreText: null,
      restoreStamp: null,
      restoreCurrent: null,
      notice: `Restored the version from ${at === null ? 'history' : localTime(at)}.${savedNote(result.backup)}`,
      noticeKind: 'ok',
    })
  } else if (result.isConflict) {
    if (view.restoreName !== null) await openRestore($, view.restoreName)
    await notify($, 'The file changed on disk meanwhile. The diff now compares against it; restore again if you still want this version.', 'warn')
  } else if (!result.isBusy) {
    await notify($, result.error, 'error')
  }
}

const openInEditor = async ($: $T) => {
  const P = await paths($)
  if (!(await $.fs.exists(P.file))) {
    await notify($, `${P.shown} does not exist yet.`, 'warn')
    return
  }
  const ran = await $.process.run(['open', '-t', P.file]).catch(() => undefined)
  if (ran === undefined || ran.exitCode !== 0) await notify($, 'Could not open the file in your editor.', 'error')
}

const diffCached = (a: string, b: string): Diff => {
  if (diffMemo !== null && diffMemo.a === a && diffMemo.b === b) return diffMemo.diff
  const diff = describeChange(a, b)
  diffMemo = { a, b, diff }
  return diff
}

/** Where a path lands, links resolved; for a file not there yet, its folder resolved plus its name. */
const realOf = async ($: $T, path: string, home: string): Promise<string | undefined> => {
  const own = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  if (own?.realPath !== undefined) return normalizePath(own.realPath, home)
  const cut = path.lastIndexOf('/')
  const dir = await $.fs.stat(cut <= 0 ? '/' : path.slice(0, cut), { resolve: true }).catch(() => undefined)
  return dir?.realPath === undefined ? undefined : normalizePath(`${dir.realPath.replace(/\/$/, '')}/${path.slice(cut + 1)}`, home)
}

const classify = async ($: $T, path: string, cwd: string): Promise<'file' | 'history' | 'other'> => {
  if (path.trim() === '') return 'other'
  const P = await paths($)
  const norm = normalizePath(path, P.home, cwd)
  if (samePath(norm, P.file)) return 'file'
  if (isInside(norm, P.hist)) return 'history'
  const [real, realFile, realHist] = await Promise.all([realOf($, norm, P.home), realOf($, P.file, P.home), realOf($, P.hist, P.home)])
  if (real !== undefined && realFile !== undefined && samePath(real, realFile)) return 'file'
  if (real !== undefined && realHist !== undefined && isInside(real, realHist)) return 'history'
  return 'other'
}

// ------------------------------------------------------------ events

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'claudemd', description: 'Open the panel for your global instructions, ~/.claude/CLAUDE.md' })
    await $.tool.register({
      name: TOOL_NAME,
      description:
        "Propose a change to the user's global instructions file, ~/.claude/CLAUDE.md. The change is shown to the user as a diff in the CLAUDE.md panel and is written only if they press Accept; you are told their decision. Pass the complete new file text. (Edit or Write calls on that file become proposals the same way.)",
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The complete proposed text of ~/.claude/CLAUDE.md.' },
          summary: { type: 'string', description: 'One or two sentences on what changes and why.' },
        },
        required: ['content'],
      },
      isDeferred: false,
    })
    startPolling($)
    await refreshDisk($, true).catch(() => undefined)
    if ((await read($, proposalA)) !== null) $.ui.status('CLAUDE.md: a proposed change awaits your review (/claudemd)')
    return next(e)
  })

  on('command.run', { command: 'claudemd' }, async $ => {
    await openPane($)
    return { text: 'Opened the CLAUDE.md panel.' }
  })

  // The guard. Edit and Write on the file become proposals; shell commands that
  // name it are refused; and after every other call that could write, the file
  // and its backups are compared with before, and a change is put back.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool === TOOL) return serveTool($, e as unknown as { content?: unknown; summary?: unknown })
    if (UNWATCHED.has(tool) || tool.startsWith('mcp__claudemd-panel__')) return next(e)
    const input = e as unknown as Record<string, unknown>
    const P = await paths($)
    if (WRITE_TOOLS.has(tool)) {
      const cwd = await $.session.cwd().catch(() => P.home)
      const where = await classify($, String(input.file_path ?? input.notebook_path ?? ''), cwd)
      if (where === 'history') return { deny: HISTORY_REFUSED }
      if (where === 'file') return { deny: await stageFromTool($, tool, input) }
    }
    if (typeof input.command === 'string' && commandTouchesProtected(input.command, P.home, P.file, P.hist) && !isReadOnlyCommand(input.command)) {
      return { deny: SHELL_REFUSED }
    }
    return watchCall($, tool, () => next(e))
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    // The guard failed before deciding: refuse what could write the file, pass the rest.
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    if (WRITE_TOOLS.has(tool)) return { deny: 'claudemd-panel: its guard failed, so this edit was refused to keep ~/.claude/CLAUDE.md safe. Try again.' }
    if (typeof input.command === 'string' && /claude/i.test(input.command)) return { deny: 'claudemd-panel: its guard failed, so this command was refused to keep ~/.claude/CLAUDE.md safe.' }
    return next(e)
  })

  // ------------------------------------------------------------ drawing

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    startPolling($)
    const [P, disk, draft, proposal, history, view] = await Promise.all([
      paths($),
      read($, diskA),
      read($, draftA),
      read($, proposalA),
      read($, historyA),
      read($, viewA),
    ])

    if (disk === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Loading {P.shown}…</Text>
          <Button key="load" label="Load" onPress={() => void refreshDisk($, true)} />
        </Box>
      )
    }

    const diskLF = toLF(disk.text)
    const isDirty = draft !== null && !isUnchanged(draft)
    const canShow = disk.exists && !disk.isTooLarge && !disk.isNotUtf8 && disk.error === null
    const drift = (base: string, baseExists: boolean) => !disk.isTooLarge && (disk.exists !== baseExists || disk.text !== base)

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text bold>CLAUDE.md</Text>
          <Text dimColor>{disk.exists ? `${canShow ? `${lineCount(diskLF)} lines · ` : ''}${sizeLabel(disk.size)}` : 'not created yet'}</Text>
          {proposal !== null && <Text color="warning">Claude proposed a change</Text>}
          {isDirty && <Text color="warning">Unsaved changes</Text>}
        </Box>
      )
    }

    // Mode, falling back where what it needs is gone.
    let mode = view.mode
    if (mode === 'proposal' && proposal === null) mode = 'view'
    if ((mode === 'edit' || mode === 'review') && draft === null) mode = 'view'
    if (mode === 'conflict' && (view.conflictFor === 'draft' ? draft === null : proposal === null)) mode = 'view'
    if (mode === 'restore' && view.restoreText === null) mode = 'history'

    const header = (
      <Box flexDirection="column">
        <Text bold>{P.shown}</Text>
        <Text dimColor>
          {!disk.exists
            ? 'Not created yet'
            : disk.isTooLarge
              ? `${sizeLabel(disk.size)} · over the panel's ${LIMIT_LABEL} limit`
              : `${canShow ? `${lineCount(diskLF)} lines · ` : ''}${sizeLabel(disk.size)} · last saved ${localTime(disk.mtimeMs)}`}
        </Text>
        <Text dimColor>Read when a session starts: changes apply to new sessions.</Text>
      </Box>
    )

    const notice =
      view.notice === null ? null : (
        <Box flexDirection="row" gap={1}>
          <Text color={view.noticeKind === 'error' ? 'error' : view.noticeKind === 'warn' ? 'warning' : 'success'}>{forDisplay(view.notice)}</Text>
          <Button key="notice-x" label="Dismiss" plain onPress={() => void setView($, { notice: null, noticeKind: null })} />
        </Box>
      )

    const unitView = (u: DiffUnit) =>
      u.kind === 'hunk' ? (
        <els.Code source={u.source} format="diff" />
      ) : (
        <Box flexDirection="column">
          <Text color={u.sign === '+' ? 'success' : u.sign === '-' ? 'error' : 'text'}>
            {u.sign === '+' ? 'Added' : u.sign === '-' ? 'Removed' : 'Unchanged'} line {u.lineNo}, {u.length} characters
            {u.pieces > 1 ? ` (piece ${u.piece} of ${u.pieces})` : ''}:
          </Text>
          <els.Code source={u.text} />
        </Box>
      )

    const diffBlock = (key: string, before: string, after: string, emptyText: string) => {
      const diff = diffCached(before, after)
      if (diff.isSame) return <Text dimColor>{emptyText}</Text>
      const pages = pagesOf(diff.units)
      const page = Math.max(0, Math.min(view.diffPage, pages.length - 1))
      return (
        <Box flexDirection="column" gap={1}>
          <Text>
            <Text color="success">+{diff.added}</Text> <Text color="error">−{diff.removed}</Text>
            <Text dimColor> lines</Text>
          </Text>
          {diff.notes.map(note => (
            <Text color="warning">{note}</Text>
          ))}
          {diff.isApproximate && <Text color="warning">Large rewrite: shown as one block replacing another.</Text>}
          {pages.length > 1 && (
            <Box flexDirection="row" gap={1}>
              <Text dimColor>
                Diff page {page + 1} of {pages.length}
              </Text>
              <Button key={`${key}-prev`} label="Previous" onPress={() => void setView($, { diffPage: Math.max(0, page - 1) })} />
              <Button key={`${key}-next`} label="Next" onPress={() => void setView($, { diffPage: Math.min(pages.length - 1, page + 1) })} />
            </Box>
          )}
          {(pages[page] ?? []).map(unitView)}
        </Box>
      )
    }

    let body
    if (mode === 'proposal' && proposal !== null) {
      const isStale = drift(proposal.base, proposal.baseExists)
      body = (
        <Box flexDirection="column" gap={1}>
          <Text bold color="warning">
            Claude proposes a change
          </Text>
          {proposal.summary !== '' && <Text>{forDisplay(proposal.summary)}</Text>}
          <Text dimColor>
            Via {proposal.source} · {localTime(proposal.createdAt)} · nothing is written unless you accept
          </Text>
          {!proposal.baseExists && (
            <Text color="warning">{proposal.text === '' ? 'Accepting creates the file, empty.' : 'Accepting creates the file.'}</Text>
          )}
          {isStale && <Text color="warning">The file changed on disk after Claude proposed this. Accept will ask how to handle that.</Text>}
          <Box flexDirection="row" gap={1}>
            <Button key="accept" label="Accept" variant="primary" onPress={() => void acceptProposal($)} />
            <Button key="reject" label="Reject" onPress={() => void rejectProposal($)} />
            <Button key="p-back" label="Back to file" plain onPress={() => void setView($, { mode: 'view' })} />
          </Box>
          {diffBlock('p', proposal.base, proposal.text, proposal.baseExists ? 'Claude’s version is the same as the file.' : 'The new file would be empty.')}
        </Box>
      )
    } else if (mode === 'conflict') {
      const forDraft = view.conflictFor === 'draft'
      const base = forDraft ? (draft?.base ?? '') : (proposal?.base ?? '')
      body = (
        <Box flexDirection="column" gap={1}>
          <Text bold color="warning">
            The file changed on disk
          </Text>
          <Text>
            {P.shown} was changed outside this panel after {forDraft ? 'you started editing' : 'Claude proposed its change'}. Nothing was written. Below is
            what changed on disk.
          </Text>
          <Box flexDirection="row" gap={1}>
            {!forDraft && proposal?.edits !== null && (
              <Button key="reapply" label="Re-apply Claude’s edits to the current file" variant="primary" onPress={() => void reapplyEdits($)} />
            )}
            <Button
              key="rebase"
              label={forDraft ? 'Review my draft against the current file' : 'Review Claude’s version against the current file'}
              variant={forDraft || proposal?.edits === null ? 'primary' : 'secondary'}
              onPress={() => void rebaseOnDisk($)}
            />
            {forDraft ? (
              <Button key="c-discard" label="Discard my draft" onPress={() => void discardDraft($)} />
            ) : (
              <Button key="c-reject" label="Reject Claude’s change" onPress={() => void rejectProposal($)} />
            )}
          </Box>
          {diffBlock('c', base, disk.text, 'No difference in content (only the file’s existence changed).')}
        </Box>
      )
    } else if (mode === 'edit' && draft !== null) {
      const parts = chunksOf(draft.text)
      const rows = Math.max(6, Math.min(lineCount(draft.fieldStart) + 2, Math.max(8, (e.props.scroll.bodyRows || 30) - 10)))
      body = (
        <Box flexDirection="column" gap={1}>
          {drift(draft.base, draft.baseExists) && <Text color="warning">The file changed on disk since you started. Saving will ask how to handle that.</Text>}
          {parts.length > 1 && (
            <Box flexDirection="row" gap={1}>
              <Text dimColor>
                Editing part {view.part + 1} of {parts.length}: {forDisplay(parts[Math.min(view.part, parts.length - 1)]?.label ?? '')}
              </Text>
              <Button key="e-prev" label="Previous part" onPress={() => void startEdit($, Math.max(0, view.part - 1))} />
              <Button key="e-next" label="Next part" onPress={() => void startEdit($, Math.min(parts.length - 1, view.part + 1))} />
            </Box>
          )}
          <els.Input
            key={`field-${draft.seq}`}
            value={draft.fieldStart}
            rows={rows}
            placeholder="Write your global instructions in Markdown…"
            submitLabel="review"
            autoFocus
            onInput={value => onType($, draft.seq, value)}
            onSubmit={value => {
              onType($, draft.seq, value)
              void reviewDraft($)
            }}
          />
          <Text dimColor>Enter reviews your changes; Shift+Enter starts a new line.</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="e-review" label="Review changes" variant="primary" onPress={() => void reviewDraft($)} />
            <Button key="e-discard" label="Discard" onPress={() => void discardDraft($)} />
            <Button key="e-back" label="Back to file (keep draft)" plain onPress={() => void leaveEdit($)} />
          </Box>
        </Box>
      )
    } else if (mode === 'review' && draft !== null) {
      const out = draftOut(draft)
      body = (
        <Box flexDirection="column" gap={1}>
          <Text bold>Unsaved changes</Text>
          {drift(draft.base, draft.baseExists) && <Text color="warning">The file changed on disk since you started. Save will ask how to handle that.</Text>}
          <Box flexDirection="row" gap={1}>
            {out !== draft.base && <Button key="save" label="Save" variant="primary" onPress={() => void saveDraft($)} />}
            <Button key="r-edit" label="Keep editing" onPress={() => void startEdit($)} />
            <Button key="r-discard" label="Discard" onPress={() => void discardDraft($)} />
          </Box>
          {diffBlock('r', draft.base, out, 'No changes to save.')}
        </Box>
      )
    } else if (mode === 'history') {
      const pages = Math.max(1, Math.ceil(history.length / HISTORY_PAGE))
      const page = Math.max(0, Math.min(view.historyPage, pages - 1))
      const shown = history.slice(page * HISTORY_PAGE, page * HISTORY_PAGE + HISTORY_PAGE)
      body = (
        <Box flexDirection="column" gap={1}>
          <Text bold>History</Text>
          <Text dimColor>
            A copy of the file is kept in {P.histShown} before every save, and whenever it is changed outside the panel. Pick one to compare and restore;
            restoring backs up the current version too.
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="h-back" label="Back to file" onPress={() => void setView($, { mode: 'view' })} />
            <Button key="h-refresh" label="Refresh" plain onPress={() => void refreshHistory($)} />
          </Box>
          {history.length === 0 && <Text dimColor>No backups yet. One is made the first time the file is saved over.</Text>}
          <Box flexDirection="column">
            {shown.map(b => (
              <Button key={`h-${b.name}`} plain onPress={() => void openRestore($, b.name)}>
                {localTime(b.at)} <Text dimColor>· {sizeLabel(b.size)}</Text>
              </Button>
            ))}
          </Box>
          {pages > 1 && (
            <Box flexDirection="row" gap={1}>
              <Text dimColor>
                Page {page + 1} of {pages} · {view.historyTotal > history.length ? `newest ${history.length} of ${view.historyTotal}` : history.length} backups
              </Text>
              <Button key="h-prev" label="Newer" onPress={() => void setView($, { historyPage: Math.max(0, page - 1) })} />
              <Button key="h-next" label="Older" onPress={() => void setView($, { historyPage: Math.min(pages - 1, page + 1) })} />
            </Box>
          )}
        </Box>
      )
    } else if (mode === 'restore' && view.restoreText !== null) {
      const at = view.restoreName === null ? null : backupTime(view.restoreName)
      const current = view.restoreStamp?.exists === false ? '' : view.restoreCurrent
      body = (
        <Box flexDirection="column" gap={1}>
          <Text bold>Restore the version from {at === null ? 'history' : localTime(at)}?</Text>
          <Text dimColor>
            {current === null
              ? 'The current file can’t be shown here, so there is no diff. Restoring replaces it, after backing it up.'
              : 'The diff shows what restoring would change in the current file.'}
          </Text>
          <Box flexDirection="row" gap={1}>
            {view.restoreText !== current && <Button key="restore" label="Restore this version" variant="primary" onPress={() => void restoreChosen($)} />}
            <Button key="restore-back" label="Back to history" onPress={() => void setView($, { mode: 'history', restoreText: null, restoreCurrent: null, restoreStamp: null })} />
          </Box>
          {current !== null && diffBlock('h', current, view.restoreText, 'This backup is the same as the current file.')}
        </Box>
      )
    } else {
      const parts = chunksOf(diskLF)
      const part = Math.max(0, Math.min(view.part, parts.length - 1))
      const chosen = parts[part] ?? { start: 0, end: diskLF.length, label: '' }
      body = (
        <Box flexDirection="column" gap={1}>
          {proposal !== null && (
            <Box flexDirection="row" gap={1}>
              <Text color="warning">Claude proposed a change.</Text>
              <Button key="v-proposal" label="Review it" variant="primary" onPress={() => void setView($, { mode: 'proposal', diffPage: 0 })} />
            </Box>
          )}
          {isDirty && (
            <Box flexDirection="row" gap={1}>
              <Text color="warning">You have unsaved changes.</Text>
              <Button key="v-review" label="Review" onPress={() => void reviewDraft($)} />
              <Button key="v-continue" label="Keep editing" plain onPress={() => void startEdit($)} />
            </Box>
          )}
          <Box flexDirection="row" gap={1}>
            {(canShow || !disk.exists) && (
              <Button key="v-edit" label={disk.exists ? 'Edit' : 'Create'} variant={proposal === null ? 'primary' : 'secondary'} onPress={() => void startEdit($)} />
            )}
            <Button
              key="v-history"
              label="History"
              onPress={() => {
                void refreshHistory($).then(() => setView($, { mode: 'history', historyPage: 0 }))
              }}
            />
            <Button key="v-refresh" label="Reload" plain onPress={() => void refreshDisk($, true)} />
            {disk.exists && <Button key="v-open" label="Open in editor" plain onPress={() => void openInEditor($)} />}
          </Box>
          {canShow && parts.length > 1 && (
            <Box flexDirection="row" gap={1}>
              <Text dimColor>
                Part {part + 1} of {parts.length}: {forDisplay(chosen.label)}
              </Text>
              <Button key="v-prev" label="Previous" onPress={() => void setView($, { part: Math.max(0, part - 1) })} />
              <Button key="v-next" label="Next" onPress={() => void setView($, { part: Math.min(parts.length - 1, part + 1) })} />
            </Box>
          )}
          {disk.error !== null ? (
            <Text color="error">{forDisplay(disk.error)}</Text>
          ) : disk.isTooLarge ? (
            <Text color="warning">This file is over the panel’s {LIMIT_LABEL} limit, so it is not shown or edited here. Open it in your editor; History still works.</Text>
          ) : disk.isNotUtf8 ? (
            <Text color="warning">This file is not UTF-8 text, so the panel only describes it. Open it in your editor.</Text>
          ) : !disk.exists ? (
            <Text dimColor>There is no global CLAUDE.md yet. Create one to give Claude instructions that apply in every project.</Text>
          ) : diskLF === '' ? (
            <Text dimColor>The file is empty.</Text>
          ) : diskLF.trim() === '' ? (
            <Text dimColor>The file holds only whitespace ({diskLF.length} characters).</Text>
          ) : (
            <els.Markdown key={`md-${part}`} text={forDisplay(diskLF.slice(chosen.start, chosen.end))} />
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {notice}
        {body}
      </Box>
    )
  })
}
