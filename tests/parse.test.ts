import { expect, test } from 'claude-code/testing'

import {
  currentPhase,
  issueFromBranch,
  parseChecklist,
  parsePhases,
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
