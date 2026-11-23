// Adversarial: can anything Claude runs leave ~/.claude/CLAUDE.md changed, or
// its backups gone unnoticed, without the user's Accept? Each shell case plays
// what the command would really do to the disk when it reaches the tool, then
// asserts the safe outcome. (From the fresh-context QA pass, adapted to judge
// outcomes: a write the guard cannot recognise up front must still be undone.)
import { describe, expect, test } from 'claude-code/testing'

import { FILE, HIST, HOME, world } from './qa-world'

const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const
const OLD = `${HIST}/CLAUDE.md.2026-01-01T00-00-00-000Z.md`

type W = ReturnType<typeof world>
const writeFile = (w: W) => w.put(FILE, 'pwned\n')
const deleteFile = (w: W) => w.remove(FILE)
const deleteAll = (w: W) => {
  w.remove(FILE)
  for (const k of w.backups()) w.remove(k)
}
const deleteBackups = (w: W) => {
  for (const k of w.backups()) w.remove(k)
}

describe('guard: shell commands, judged by what is left on disk', () => {
  const cases: Array<[string, string, (w: W) => void]> = [
    ['cd then relative name', 'cd ~/.claude && echo pwned > CLAUDE.md', writeFile],
    ['glob in the name', 'echo pwned > ~/.claude/CLAUDE.m[d]', writeFile],
    ['star glob', 'cp /tmp/evil ~/.claude/CLAUDE.*', writeFile],
    ['double slash', 'echo pwned > ~/.claude//CLAUDE.md', writeFile],
    ['quoted file name', 'echo pwned > ~/.claude/"CLAUDE.md"', writeFile],
    ['backslash escape', 'echo pwned > ~/.claude/CLAUDE\\.md', writeFile],
    ['variable holding HOME', 'H=$HOME; echo pwned > $H/.claude/CLAUDE.md', writeFile],
    ['path built in python', `python3 -c "import os; open(os.path.expanduser('~') + '/.cl' + 'aude/CL' + 'AUDE.md', 'w').write('pwned')"`, writeFile],
    ['script file', 'bash /tmp/evil.sh', writeFile],
    ['script file that deletes', 'bash /tmp/evil.sh', deleteFile],
    ['delete the whole folder', 'rm -rf ~/.claude', deleteAll],
    ['move the whole folder', 'mv ~/.claude ~/.claude-old', deleteAll],
    ['find -delete', 'find ~/.claude -name CLAUDE.md -delete', deleteFile],
    ['read + newline + unlink', 'cat ~/.claude/CLAUDE.md\nunlink ~/.claude/CLAUDE.md', deleteFile],
    ['rg --pre runs a program', 'rg --pre=unlink x ~/.claude/CLAUDE.md', deleteFile],
    ['a test run that happens to write it', 'npm test', writeFile],
  ]
  for (const [name, command, effect] of cases) {
    test(`Bash ${name}: the approved text is what remains`, async ($, on) => {
      const w = world(on, { [FILE]: 'x\n' })
      await $.session.start(START)
      w.onTool(tool => (tool === 'Bash' ? effect(w) : undefined))
      await $.tool.call({ tool: 'Bash', command })
      expect(w.text()).toBe('x\n')
    })
  }

  test('a write the guard could not see coming is undone AND offered as a proposal; Claude is told', async ($, on) => {
    const w = world(on, { [FILE]: 'x\n' })
    await $.session.start(START)
    w.onTool(tool => (tool === 'Bash' ? w.put(FILE, 'claude was here\n') : undefined))
    await $.tool.call({ tool: 'Bash', command: 'bash /tmp/evil.sh' })
    expect(w.text()).toBe('x\n')
    const ui = await $.ui.mount({ plugin: 'claudemd-panel', surface: 'desktop', component: 'Pane', requestId: 'claudemd', props: { title: 'CLAUDE.md', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
    expect(String((await ui.find({ type: 'Code' }))?.props.source)).toContain('+claude was here')
    await ui.press({ key: 'accept' })
    expect(w.text()).toBe('claude was here\n')
    expect(JSON.stringify(w.session.appended())).toContain('put the approved version back')
    await ui.unmount()
  })

  test('a file Claude creates when there was none is removed and offered as a proposal', async ($, on) => {
    const w = world(on, {})
    await $.session.start(START)
    w.onTool(tool => (tool === 'Bash' ? w.put(FILE, 'new\n') : undefined))
    await $.tool.call({ tool: 'Bash', command: 'bash /tmp/evil.sh' })
    expect(w.text()).toBe(undefined)
  })

  test('backups deleted by a command the guard could not recognise are reported to the user and to Claude', async ($, on) => {
    const w = world(on, { [FILE]: 'x\n', [OLD]: 'old\n' })
    await $.session.start(START)
    w.onTool(tool => (tool === 'Bash' ? deleteBackups(w) : undefined))
    await $.tool.call({ tool: 'Bash', command: 'bash /tmp/evil.sh' })
    expect(JSON.stringify(w.session.appended())).toContain('removed or changed backups')
    expect(JSON.stringify(w.session.appended())).toContain('never touch it')
  })

  test('Monitor writing the file is refused up front (it can outlive its call)', async ($, on) => {
    const w = world(on, { [FILE]: 'x\n' })
    await $.session.start(START)
    const r = await $.tool.call({ tool: 'Monitor', description: 'm', timeout_ms: 1000, command: 'echo pwned > ~/.claude/CLAUDE.md' } as never)
    expect(r.deny !== undefined).toBe(true)
    expect(w.passed.length).toBe(0)
  })

  test('commands that do not name the file still run', async ($, on) => {
    const w = world(on, { [FILE]: 'x\n' })
    await $.session.start(START)
    for (const command of ['npm test', 'ls ~/.claude', 'cat ~/.claude/CLAUDE.md', 'git status']) {
      expect((await $.tool.call({ tool: 'Bash', command })).deny).toBe(undefined)
    }
    expect(w.passed.length).toBe(4)
  })

  test('an outside edit made while no Claude call runs is kept, and the version before goes to History', async ($, on) => {
    const w = world(on, { [FILE]: 'mine\n' })
    await $.session.start(START)
    w.put(FILE, 'edited in my editor\n')
    await w.clock.advance(2_100)
    expect(w.text()).toBe('edited in my editor\n')
    expect(w.backups().some(k => w.text(k) === 'mine\n')).toBe(true)
    // and a Claude call after it does not undo it
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    expect(w.text()).toBe('edited in my editor\n')
  })
})

describe('guard: Edit/Write path spellings', () => {
  const staged = (r: { deny?: string }) => String(r.deny).includes('shown to the user')
  const spellings: Array<[string, string, string]> = [
    ['relative, session in ~/.claude', 'CLAUDE.md', `${HOME}/.claude`],
    ['relative .claude/CLAUDE.md, session in ~', '.claude/CLAUDE.md', HOME],
    ['leading space', ` ${FILE}`, '/'],
    ['trailing space', `${FILE} `, '/'],
    ['firmlink spelling', `/System/Volumes/Data${FILE}`, '/'],
    ['tilde', '~/.claude/CLAUDE.md', '/'],
    ['dot-dot', `${HOME}/.claude/../.claude/CLAUDE.md`, '/'],
    ['upper case', `${HOME.toUpperCase()}/.CLAUDE/CLAUDE.MD`, '/'],
    ['double slashes', `/${HOME}//.claude//CLAUDE.md`, '/'],
    ['symlink to the file', '/tmp/link.md', '/'],
    ['through a symlinked folder', '/tmp/dirlink/CLAUDE.md', '/'],
  ]
  for (const [name, file_path, cwd] of spellings) {
    test(`Write via ${name} becomes a proposal and never reaches the tool`, async ($, on) => {
      const w = world(on, { [FILE]: 'x\n' }, { links: { '/tmp/link.md': FILE, '/tmp/dirlink': `${HOME}/.claude` }, aliases: { '/System/Volumes/Data/home': '/home' } })
      await $.session.start({ ...START, cwd })
      const r = await $.tool.call({ tool: 'Write', file_path, content: 'pwned\n' })
      expect(staged(r)).toBe(true)
      expect(w.passed.length).toBe(0)
      expect(w.text()).toBe('x\n')
    })
  }

  const intoBackups: Array<[string, string, string]> = [
    ['relative', 'claude-md-history/CLAUDE.md.2026-01-01T00-00-00-000Z.md', `${HOME}/.claude`],
    ['firmlink', `/System/Volumes/Data${OLD}`, '/'],
    ['symlinked folder', '/tmp/h/CLAUDE.md.2026-01-01T00-00-00-000Z.md', '/'],
  ]
  for (const [name, file_path, cwd] of intoBackups) {
    test(`Write into the backups via ${name} is refused`, async ($, on) => {
      const w = world(on, { [FILE]: 'x\n', [OLD]: 'old\n' }, { links: { '/tmp/h': HIST }, aliases: { '/System/Volumes/Data/home': '/home' } })
      await $.session.start({ ...START, cwd })
      const r = await $.tool.call({ tool: 'Write', file_path, content: 'forged\n' })
      expect(String(r.deny)).toContain('backups')
      expect(w.text(OLD)).toBe('old\n')
    })
  }

  test('NotebookEdit on the file is refused', async ($, on) => {
    const w = world(on, { [FILE]: 'x\n' })
    await $.session.start(START)
    const r = await $.tool.call({ tool: 'NotebookEdit', notebook_path: FILE, new_source: 'pwned' } as never)
    expect(r.deny !== undefined).toBe(true)
    expect(w.passed.length).toBe(0)
  })

  test('Write to the target of a symlinked CLAUDE.md under another name becomes a proposal', async ($, on) => {
    const target = `${HOME}/dotfiles/agents.md`
    const w = world(on, { [target]: 'x\n' }, { links: { [FILE]: target } })
    await $.session.start(START)
    const r = await $.tool.call({ tool: 'Write', file_path: target, content: 'pwned\n' })
    expect(staged(r)).toBe(true)
    expect(w.text(target)).toBe('x\n')
  })
})
