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
    if (args === 'git branch --show-current') return out('fix/12-profile-texts\n')
    if (args === 'git remote get-url origin') return out('git@github.com:steve/cronista.git\n')
    if (args.endsWith('repos/steve/cronista/issues/12')) return out(ISSUE)
    if (args.includes('/issues/12/comments')) {
      return out([{ user: { login: 'claude' }, created_at: '2026-10-20T10:00:00Z', body: 'phase 1 merged, next: rendering' }])
    }
    if (args.includes('/pulls?')) return out([])
    if (args.endsWith('repos/steve/cronista') || args.endsWith('projects/tools%2Farchive')) return out({})
    if (args.includes('projects/tools%2Farchive/issues?')) return out([])
    if (args.includes('repos/steve/cronista/issues?')) return out([ISSUE, { ...ISSUE, number: 13, body: '- [x] done' }])
    return { value: { ...RUN, exitCode: 1, stderr: `unexpected ${args}` } }
  })
  on('fs.exists', (_, e) => ({ value: e.path === '/work/cronista/openspec/changes' }))
  on('fs.list', () => ({
    value: [
      { name: 'profile-texts', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
      { name: 'archive', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
    ],
  }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('profile-texts/tasks.md') ? TASKS : '' }))
  on('command.register', () => ({ value: { command: 'where' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  return { calls, clock }
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
  expect((await ui.find({ type: 'Text', text: /Profile texts/ }))?.text).toBe('Profile texts · phase 2/4')
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
