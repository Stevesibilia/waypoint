import { expect, test } from 'claude-code/testing'

import {
  annotateIssues,
  currentPhase,
  findMentionsInCommand,
  findMentionsInText,
  issueFromBranch,
  parseChecklist,
  parsePhases,
  parseRegistryEntry,
  parseProjectArg,
  parseRemote,
  parseTasks,
} from '../hooks/parse'

test('the checklist keeps top-level boxes outside code fences', () => {
  const body = [
    'Intro',
    '- [x] Phase 1: schema',
    '  - [ ] nested, not a phase',
    '* [X] Phase 2: rendering',
    '```',
    '- [ ] inside a fence',
    '```',
    '- [ ] Phase 3: frontend',
  ].join('\n')

  expect(parseChecklist(body)).toEqual([
    { text: 'Phase 1: schema', isDone: true },
    { text: 'Phase 2: rendering', isDone: true },
    { text: 'Phase 3: frontend', isDone: false },
  ])
  expect(currentPhase(parseChecklist(body))).toBe(3)
  expect(currentPhase([{ text: 'a', isDone: true }])).toBe(2)
})

test('Phase lines win over other checkboxes in the issue', () => {
  const body = '- [x] Phase 1: a\n- [ ] read the docs\n- [ ] Phase 2: b'

  expect(parsePhases(body).map(phase => phase.text)).toEqual(['Phase 1: a', 'Phase 2: b'])
  expect(parsePhases('- [ ] one\n- [x] two')).toHaveLength(2)
})

test('tasks.md groups by section heading', () => {
  const text = ['# Title', '## 1. Schema', '- [x] 1.1 a', '- [ ] 1.2 b', '## 2. Empty', '## 3. Docs', '- [ ] 3.1 c'].join('\n')

  expect(parseTasks(text)).toEqual([
    { title: '1. Schema', items: [{ text: '1.1 a', isDone: true }, { text: '1.2 b', isDone: false }] },
    { title: '3. Docs', items: [{ text: '3.1 c', isDone: false }] },
  ])
})

test('the issue number comes from the branch name', () => {
  expect(issueFromBranch('fix/12-profile-texts')).toEqual({ number: 12, slug: 'profile-texts' })
  expect(issueFromBranch('42_thing')).toEqual({ number: 42, slug: 'thing' })
  expect(issueFromBranch('7')).toEqual({ number: 7, slug: '' })
  expect(issueFromBranch('feat/site-front-matter')).toEqual({ number: null, slug: 'site-front-matter' })
  expect(issueFromBranch('main')).toEqual({ number: null, slug: 'main' })
})

test('remotes in every spelling', () => {
  expect(parseRemote('ssh://git@gitlab.example.com:2223/tools/archive.git')).toEqual({
    host: 'gitlab.example.com',
    path: 'tools/archive',
  })
  expect(parseRemote('git@github.com:steve/waypoint.git')).toEqual({ host: 'github.com', path: 'steve/waypoint' })
  expect(parseRemote('https://gitlab.com/a/b/c')).toEqual({ host: 'gitlab.com', path: 'a/b/c' })
  expect(parseRemote('/local/path')).toBeNull()
})

test('/where add arguments', () => {
  expect(parseProjectArg('group/repo', 'gitlab.example.com')).toEqual({
    forge: 'gitlab',
    host: 'gitlab.example.com',
    path: 'group/repo',
  })
  expect(parseProjectArg('github.com/owner/repo', 'gitlab.example.com')).toEqual({
    forge: 'github',
    host: 'github.com',
    path: 'owner/repo',
  })
  expect(parseProjectArg('https://gitlab.example.com/tools/archive', 'github.com')).toEqual({
    forge: 'gitlab',
    host: 'gitlab.example.com',
    path: 'tools/archive',
  })
  expect(parseProjectArg('repo', 'github.com')).toBeNull()
})

test('a registry entry reads with every field optional', () => {
  expect(parseRegistryEntry('{"pid":7,"sessionId":"abc123456","cwd":"/w","status":"busy","name":"impl"}')).toEqual({
    pid: 7,
    sessionId: 'abc123456',
    cwd: '/w',
    status: 'working',
    name: 'impl',
  })
  expect(parseRegistryEntry('{"pid":7,"cwd":"/w","status":"new-state"}')).toEqual({
    pid: 7,
    sessionId: '',
    cwd: '/w',
    status: 'unknown',
    name: 'pid 7',
  })
  expect(parseRegistryEntry('{"cwd":"/w"}')).toBeNull()
  expect(parseRegistryEntry('not json')).toBeNull()
})

test('mentions in the agent text: bare, qualified and URLs, never in code', () => {
  const text = 'Next: #12 (TLS), #11, #32.\nSee steve/other#3, https://github.com/a/b/issues/9 and `#99`.\n```\n#98\n```'

  expect(findMentionsInText(text)).toEqual([
    { host: 'github.com', path: 'a/b', number: 9 },
    { host: null, path: 'steve/other', number: 3 },
    { host: null, path: null, number: 12 },
    { host: null, path: null, number: 11 },
    { host: null, path: null, number: 32 },
  ])
  expect(findMentionsInText('color: #fff; &#39; page#2')).toEqual([])
})

test('mentions in gh and glab commands', () => {
  expect(findMentionsInCommand('gh issue view 31 -R Stevesibilia/rpg-promptbook --comments')).toEqual([
    { host: null, path: 'Stevesibilia/rpg-promptbook', number: 31 },
  ])
  expect(findMentionsInCommand('glab issue note 80 --message "x"')).toEqual([{ host: null, path: null, number: 80 }])
  expect(findMentionsInCommand('glab api --hostname gitlab.example.com "projects/tools%2Farchive/issues/80/notes"')).toEqual([
    { host: 'gitlab.example.com', path: 'tools/archive', number: 80 },
  ])
  expect(findMentionsInCommand('gh api repos/a/b/issues/7')).toEqual([{ host: 'github.com', path: 'a/b', number: 7 }])
  expect(findMentionsInCommand('git log --oneline')).toEqual([])
})

test('titles go beside bare references, once, outside code', () => {
  const titleOf = (n: number) => ({ 12: 'TLS to the database on the homelab', 11: 'Sign-in throttle' } as Record<number, string>)[n]

  expect(annotateIssues('Next: #12, #11 (done), #32, `#12`.', titleOf)).toBe(
    'Next: #12 (TLS to the database on the homelab), #11 (done), #32, `#12`.',
  )
  expect(annotateIssues('```\n#12\n```', titleOf)).toBe('```\n#12\n```')
})
