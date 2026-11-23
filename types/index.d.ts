/** What the panel last read of ~/.claude/CLAUDE.md. `text` is empty unless the panel can show it. */
export type Disk = {
  exists: boolean
  text: string
  size: number
  mtimeMs: number
  /** Over the panel's limit: described, never loaded into the panel. */
  isTooLarge: boolean
  /** Not valid UTF-8: shown read-only, so no write can mangle it. */
  isNotUtf8: boolean
  error: string | null
}

/** A file's identity at a moment: enough to tell whether it changed since. */
export type FileStamp = { exists: boolean; size: number; mtimeMs: number }

/** The person's unsaved edit; `text` has LF line breaks, `base` is the file as it was when editing began. */
export type Draft = {
  base: string
  baseExists: boolean
  text: string
  /** How `base` broke its lines; a CRLF file is saved back as CRLF. */
  endings: 'none' | 'lf' | 'crlf' | 'mixed'
  /** The part of `text` the field is editing (the whole text unless the file is large). */
  partStart: number
  partEnd: number
  /** What the field was drawn holding; kept fixed so typing is never reset mid-edit. */
  fieldStart: string
  seq: number
}

export type ProposalEdit = { old: string; neu: string; all: boolean }

/** A change Claude proposed; nothing is written unless the person accepts it. */
export type Proposal = {
  id: string
  base: string
  baseExists: boolean
  text: string
  summary: string
  source: string
  createdAt: number
  /** The Edit calls behind it, so they can be re-applied if the file changed meanwhile. */
  edits: ProposalEdit[] | null
}

export type Backup = { name: string; size: number; at: number }

export type Mode = 'view' | 'edit' | 'review' | 'proposal' | 'conflict' | 'history' | 'restore'

export type View = {
  mode: Mode
  part: number
  diffPage: number
  historyPage: number
  notice: string | null
  noticeKind: 'ok' | 'warn' | 'error' | null
  conflictFor: 'draft' | 'proposal' | null
  restoreName: string | null
  restoreText: string | null
  /** The file as it stood when the restore was opened; the restore is refused if it changed since. */
  restoreStamp: FileStamp | null
  /** The current file's text for the diff, when the panel can show it. */
  restoreCurrent: string | null
  /** How many backups History holds (the list keeps the newest few hundred). */
  historyTotal: number
}

declare module 'claude-code' {
  interface PluginState {
    'claudemd-panel': {
      disk: Shaped<Disk | null>
      draft: Shaped<Draft | null>
      proposal: Shaped<Proposal | null>
      history: Shaped<Backup[]>
      view: Shaped<View>
    }
  }
}
