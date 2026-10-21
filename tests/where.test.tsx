import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ISSUE = {
  number: 12,
  title: 'Profile texts',
  html_url: 'https://github.com/steve/cronista/issues/12',
  state: 'open',
  comments: 1,
  body: '- [x] Phase 1: schema\n- [ ] Phase 2: rendering\n- [ ] Phase 3: frontend\n- [ ] Phase 4: docs',
}
const TASKS = '## 1. Schema\n- [x] 1.1 a\n- [x] 1.2 b\n## 2. Rendering\n- [x] 2.1 c\n- [ ] 2.2 d\n'

const SITE = { title: 'Waypoint', isFocused: false, bodyColumns: 80, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const PANE = { plugin: 'waypoint', component: 'Pane', requestId: 'waypoint', props: { ...SITE, placement: 'dock' } } as const
const BAND = {
  plugin: 'waypoint',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const SESSIONS = '/home/u/.claude/sessions'
const REGISTRY: Record<string, object> = {
  '101.json': { pid: 101, sessionId: 's-101', cwd: '/work/cronista', status: 'waiting', name: 'implementer' },
  '102.json': { pid: 102, sessionId: 's-102', cwd: '/work/cronista', status: 'busy', name: 'architect' },
  '103.json': { pid: 103, sessionId: 's-103', cwd: '/work/cronista', status: 'busy', name: 'gone' },
  '104.json': { pid: 104, sessionId: 'abcdef1234', cwd: '/work/other/sub', status: 'idle' },
  '105.json': { pid: 105, sessionId: 'spare-session', cwd: '/work/cronista', status: 'idle' },
}

const RUN = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

/** `/where <args>` as typed at the prompt. */
const where = (args: string) =>
  ({ command: 'where', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } }) as const

/** A repo on `fix/12-profile-texts` whose GitHub issue has 4 phases. */
const world = (on: On, store: Record<string, unknown> = {}) => {
  const clock = mock.clock(on)
  mock.store(on, store)
  const calls: string[][] = []
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    const out = (stdout: unknown) => ({
      value: { ...RUN, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout) },
    })
    const args = e.argv.join(' ')
    if (args === 'git rev-parse --show-toplevel') return out('/work/cronista\n')
    if (args === 'ps -o pid=,command= -p 101,102,103,104,105') {
      return out('  101 claude\n  102 claude --resume x\n  104 claude\n  105 claude bg-spare --bg-spare /tmp/s.sock\n')
    }
    if (args === 'git -C /work/cronista rev-parse --show-toplevel --abbrev-ref HEAD') {
      return out('/work/cronista\nfix/12-profile-texts\n')
    }
    if (args === 'git -C /work/cronista remote get-url origin') return out('git@github.com:steve/cronista.git\n')
    if (args === 'git -C /work/other/sub rev-parse --show-toplevel --abbrev-ref HEAD') return out('/work/other\nfeat/7-x\n')
    if (args === 'git -C /work/other/sub remote get-url origin') return out('git@github.com:steve/other.git\n')
    if (args === 'git branch --show-current') return out('fix/12-profile-texts\n')
    if (args === 'git remote get-url origin') return out('git@github.com:steve/cronista.git\n')
    if (args.endsWith('repos/steve/cronista/issues/12')) return out(ISSUE)
    if (args.includes('/issues/12/comments')) {
      return out([{ user: { login: 'claude' }, created_at: '2026-10-20T10:00:00Z', body: 'phase 1 merged, next: rendering' }])
    }
    if (args.includes('/pulls?')) return out([])
    if (args.endsWith('repos/steve/cronista') || args.endsWith('projects/tools%2Farchive')) return out({})
    if (args.includes('projects/tools%2Farchive/issues?')) return out([])
    if (args.includes('repos/steve/cronista/issues?')) return out([ISSUE, { ...ISSUE, number: 13, title: 'Old bug', body: '- [x] done' }])
    if (args.endsWith('repos/steve/cronista/issues/13')) return out({ ...ISSUE, number: 13, title: 'Old bug', state: 'closed', body: '' })
    if (args.endsWith('repos/steve/cronista/issues/77')) return { value: { ...RUN, exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' } }
    return { value: { ...RUN, exitCode: 1, stderr: `unexpected ${args}` } }
  })
  mock.env(on, { HOME: '/home/u' })
  on('session.id', () => ({ value: 's-102' }))
  const reads: string[] = []
  on('fs.exists', (_, e) => ({ value: e.path === '/work/cronista/openspec/changes' || e.path === SESSIONS }))
  const entry = (name: string, kind: 'dir' | 'file') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })
  on('fs.list', (_, e) => ({
    value:
      e.path === SESSIONS
        ? [...Object.keys(REGISTRY), '101.abc.key'].map(name => entry(name, 'file'))
        : [entry('profile-texts', 'dir'), entry('archive', 'dir')],
  }))
  on('fs.read', (_, e) => {
    reads.push(e.path)
    const registry = REGISTRY[e.path.slice(SESSIONS.length + 1)]
    return { value: registry ? JSON.stringify(registry) : e.path.endsWith('profile-texts/tasks.md') ? TASKS : '' }
  })
  on('command.register', () => ({ value: { command: 'where' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  return { calls, clock, reads }
}

test('the band shows the issue, the phase and the tasks', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/work/cronista', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const band = await ui.find({ type: 'Text', text: /cronista/ })
    expect(band?.text).toBe('cronista #12 profile-texts · phase 2/4 · tasks 3/4')
    await ui.unmount()
  }
})

test('the pane lists phases, the open task group and the last comment', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/work/cronista', surface: 'terminal', isInteractive: true })
  await $.command.run(where(''))
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Phase 2/ }))?.text).toBe('▸ Phase 2: rendering')
    expect((await ui.find({ type: 'Text', text: /2\.2 d/ }))?.text).toContain('○ 2.2 d')
    expect(await ui.find({ type: 'Text', text: /Last comment · claude · 2026-10-20/ })).toBeDefined()
    expect(await ui.find({ key: 'track' })).toBeDefined()
    await ui.unmount()
  }
})

test('/where add tracks the current repo and All lists issues in progress', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/work/cronista', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const added = await $.command.run(where('add'))
  expect(added.text).toBe('Tracking github.com/steve/cronista (github).')
  expect((await $.command.run(where('add'))).text).toContain('Already tracked')
  expect((await $.command.run(where('list'))).text).toContain('cronista  github.com/steve/cronista')

  await $.command.run(where('all'))
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Profile texts/ }))?.text).toBe('Profile texts · phase 2/4')
  expect(await ui.find({ type: 'Text', text: /#13/ })).toBeUndefined()
  await ui.unmount()

  expect((await $.command.run(where('remove cronista'))).text).toBe(
    'Stopped tracking github.com/steve/cronista.',
  )
  expect((await $.command.run(where('list'))).text).toContain('No projects tracked')
})

test('a GitLab project is read through glab with its host', async ($, on) => {
  const { calls } = world(on)
  await $.session.start({ cwd: '/work/cronista', surface: 'terminal', isInteractive: true })
  await $.command.run(where('add gitlab.example.com/tools/archive'))

  expect(calls).toContainEqual(['glab', 'api', '--hostname', 'gitlab.example.com', 'projects/tools%2Farchive'])
})

test('with All open, a project added shows up without pressing Refresh', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/work/cronista', surface: 'terminal', isInteractive: true })
  await $.command.run(where('all'))
  await clock.settle()

  expect((await $.command.run(where('add gitlab.example.com/tools/archive'))).text).toBe(
    'Tracking gitlab.example.com/tools/archive (gitlab).',
  )
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^archive/ }))?.text).toBe('archive')
  expect(await ui.find({ type: 'Text', text: /nothing in progress/ })).toBeDefined()
  await ui.unmount()
})

test('the repo view lists the live sessions on this repo', async ($, on) => {
  const { clock, reads } = world(on)
  await $.session.start({ cwd: '/work/cronista', surface: 'terminal', isInteractive: true })
  await $.command.run(where('repo'))
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /implementer/ }))?.text).toBe('  ◐ needs you · implementer · #12 profile-texts')
    expect((await ui.find({ type: 'Text', text: /architect/ }))?.text).toBe(
      '  ● working · architect (this session) · #12 profile-texts',
    )
    expect(await ui.find({ type: 'Text', text: /gone/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /spare-se/ })).toBeUndefined()
    await ui.unmount()
  }
  expect(reads.some(path => path.endsWith('.key'))).toBe(false)
})

test('the all view puts each session under its project, with the issue phase', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/work/cronista', surface: 'terminal', isInteractive: true })
  await $.command.run(where('add'))
  await $.command.run(where('all'))
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /implementer/ }))?.text).toBe(
    '  ◐ needs you · implementer · #12 Profile texts · phase 2/4',
  )
  expect(await ui.find({ type: 'Text', text: /Other sessions/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /abcdef12/ }))?.text).toBe('  ○ idle · abcdef12 · other · #7 x')
  await ui.unmount()
})

test('the agent message shows issue links and titles, and both views list what it mentioned', async ($, on) => {
  const { clock } = world(on)
  // The engine beneath: draws a message block as markdown, ends a turn as told.
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Markdown } = $.ui.resolve(e)
    return <Markdown key="text" text={e.props.text} />
  })
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'Looking at #13.', toolUses: [] }] }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/work/cronista', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const message = await $.ui.mount({
      plugin: 'waypoint',
      component: 'AssistantMessage',
      props: { text: 'Next: #12 and #77, see steve/other#3.', isFirstOfReply: true },
      surface,
    })
    expect((await message.find({ key: 'text' }))?.text).toBe(
      'Next: [#12](https://github.com/steve/cronista/issues/12) (Profile texts) and #77, see [steve/other#3](https://github.com/steve/other/issues/3).',
    )
    await message.unmount()
  }

  await $.turn.complete({ answer: 'Next: #12 and #77.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  await $.command.run(where('repo'))
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Mentioned in this session/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^Old bug/ }))?.text).toBe('Old bug · closed')
  expect((await ui.find({ type: 'Text', text: /^Profile texts · open/ }))?.text).toBe('Profile texts · open · phase 2/4')
  expect(await ui.find({ type: 'Text', text: /#77/ })).toBeUndefined()
  await ui.unmount()

  await $.command.run(where('all'))
  await clock.settle()
  const all = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await all.find({ type: 'Text', text: /Mentioned in this session/ })).toBeDefined()
  await all.unmount()
})

test('/where add takes several paths, also pasted as /where add lines', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/work/cronista', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const added = await $.command.run(where('add github.com/steve/cronista\n/where add gitlab.example.com/tools/archive'))
  expect(added.text).toBe('Tracking github.com/steve/cronista (github).\nTracking gitlab.example.com/tools/archive (gitlab).')
})
