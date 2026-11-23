// QA (adversarial): sizes between ~2 MB and the 4 MB the panel says it handles.
// The state store refuses a value over 4,194,304 characters of JSON; the draft,
// proposal and restore view each hold TWO copies of the file. Every test asserts
// the safe / promised outcome: a failure is a finding.
import { describe, expect, test } from 'claude-code/testing'

import { FILE, HIST, HOME, PANE, world } from './qa-world'

const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const
const MB25 = `${'x'.repeat(99)}\n`.repeat(25_000) // 2.5 MB, 25k lines
const TARGET = `${HOME}/dotfiles/agents.md` // a common setup: ~/.claude/CLAUDE.md -> ~/dotfiles/agents.md

describe('limits: a file over the panel limit (256 KB) is described, never mangled', () => {
  test('a 2.5 MB file is explained, with no Edit, and History still opens', async ($, on) => {
    world(on, { [FILE]: MB25 })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ key: 'v-edit' })).toBe(undefined)
    expect((await ui.find({ text: /over the panel/ })) !== undefined).toBe(true)
    await ui.press({ key: 'v-history' })
    expect((await ui.find({ text: 'History' })) !== undefined).toBe(true)
    await ui.unmount()
  })

  test('Claude’s Write on a 2.5 MB file is refused with a clear reason (not a guard failure) and never reaches the tool', async ($, on) => {
    const w = world(on, { [FILE]: MB25 })
    await $.session.start(START)
    const r2 = await $.tool.call({ tool: 'Write', file_path: FILE, content: MB25.replace('x', 'y') })
    expect(String(r2.deny)).toContain('Not staged')
    expect(String(r2.deny)).toContain('limit')
    expect(w.passed.length).toBe(0)
    expect(w.text()).toBe(MB25)
  })

  test('a just-under-4 MiB file with many short lines is shown, not stuck on “Loading…”', async ($, on) => {
    const text = `${'z'.repeat(19)}\n`.repeat(204_000) // 4,080,000 bytes < 4,194,304; JSON escapes add 204k chars
    world(on, { [FILE]: text })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'load' }).catch(() => undefined)
    const loading = (await ui.find({ text: /^Loading/ })) !== undefined
    expect(loading).toBe(false)
    await ui.unmount()
  })

  test('a 2.5 MB backup is not restored from the panel; it says why and changes nothing', async ($, on) => {
    const older = MB25.replace(/x/, 'O')
    const w = world(on, { [FILE]: MB25, [`${HIST}/CLAUDE.md.2026-01-01T00-00-00-000Z.md`]: older })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'v-history' })
    await ui.press({ key: 'h-CLAUDE.md.2026-01-01T00-00-00-000Z.md' })
    expect(await ui.find({ key: 'restore' })).toBe(undefined)
    expect((await ui.find({ text: /over the panel/ })) !== undefined).toBe(true)
    expect(w.text()).toBe(MB25)
    await ui.unmount()
  })
})

describe('limits: the guard’s fallback when staging throws', () => {
  test('symlinked CLAUDE.md, 2.5 MB: Write through the link’s target name must not reach the tool', async ($, on) => {
    const w = world(on, { [TARGET]: MB25 }, { links: { [FILE]: TARGET } })
    await $.session.start(START)
    // Claude rewrites one line of the 2.5 MB file: base + text = 5 MB > the state limit, so staging throws.
    const r = await $.tool.call({ tool: 'Write', file_path: TARGET, content: MB25.replace('x', 'pwned') })
    expect({ deny: String(r.deny).slice(0, 60), reachedTool: w.passed.map(p => p.tool) }).toEqual({ deny: expect.any(String) as never, reachedTool: [] })
  })

  test('symlinked CLAUDE.md, small file: an Edit whose replace_all result passes the state limit must not reach the tool', async ($, on) => {
    const w = world(on, { [TARGET]: 'see the tree\n'.repeat(5_000) }, { links: { [FILE]: TARGET } })
    await $.session.start(START)
    const r = await $.tool.call({ tool: 'Edit', file_path: TARGET, old_string: 'e', new_string: 'E'.repeat(200), replace_all: true })
    expect({ deny: String(r.deny).slice(0, 60), reachedTool: w.passed.map(p => p.tool) }).toEqual({ deny: expect.any(String) as never, reachedTool: [] })
  })

  test('sanity: the same oversized Edit through the canonical path is refused (fails closed)', async ($, on) => {
    const w = world(on, { [FILE]: 'see the tree\n'.repeat(5_000) })
    await $.session.start(START)
    const r = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'e', new_string: 'E'.repeat(200), replace_all: true })
    expect(r.deny !== undefined && w.passed.length === 0).toBe(true)
  })

  test('propose_change over the state limit answers Claude with a clear refusal (no fall-through)', async ($, on) => {
    const w = world(on, { [FILE]: 'small\n' })
    await $.session.start(START)
    const r = (await $.tool.call({ tool: 'mcp__claudemd-panel__propose_change', content: `${'x'.repeat(1000)}\n`.repeat(4400) } as never)) as { result?: unknown; deny?: string }
    expect({ fellThrough: w.passed.map(p => p.tool), answer: String(r.result ?? r.deny).slice(0, 60) }).toEqual({ fellThrough: [], answer: expect.stringContaining('Not staged') as never })
  })
})
