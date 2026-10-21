import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent, AgentStatus, MentionedIssue, OpenIssue, Project, ProjectRow, RepoStatus, Tasks, View } from '../types'
import { git, readAgents } from './agents'
import { checkProject, fetchIssue, fetchIssueSummary, fetchOpenIssues, fetchOpenTitles } from './forge'
import type { Mention } from './parse'
import {
  annotateIssues,
  currentPhase,
  findMentionsInCommand,
  findMentionsInText,
  issueUrl,
  issueFromBranch,
  parseProjectArg,
  parseRemote,
  parseTasks,
  projectFrom,
  projectName,
  sameProject,
} from './parse'

const PANE = 'waypoint'
const TICK_MS = 60_000
// Agents change state within seconds; their reads are local and cheap.
const AGENT_TICK_MS = 5_000
const MAX_MENTIONS = 8
const USAGE = [
  'Usage:',
  '  /where              open the pane',
  '  /where repo | all   open it on the current repo or on every tracked project',
  '  /where add [path]   track the current repo, or group/repo, host/group/repo, a URL',
  '  /where remove <name or path>',
  '  /where list',
  '  /where refresh',
].join('\n')

const repoAtom = atom({ plugin: 'waypoint', key: 'repo' } as const, null)
const allAtom = atom({ plugin: 'waypoint', key: 'all' } as const, null)
const viewAtom = atom({ plugin: 'waypoint', key: 'view' } as const, 'repo')
const projectsAtom = atom({ plugin: 'waypoint', key: 'projects' } as const, [])
const loadingAtom = atom({ plugin: 'waypoint', key: 'isLoading' } as const, false)
const paneAtom = atom({ plugin: 'waypoint', key: 'isPaneOpen' } as const, false)
const agentsAtom = atom({ plugin: 'waypoint', key: 'agents' } as const, null)
const mentionsAtom = atom({ plugin: 'waypoint', key: 'mentions' } as const, [])

const mentionKey = (project: Project, number: number) => `${project.host}/${project.path.toLowerCase()}#${number}`

const AGENT_LOOK: Record<AgentStatus, { glyph: string; label: string; color?: 'success' | 'warning' }> = {
  waiting: { glyph: '◐', label: 'needs you', color: 'warning' },
  working: { glyph: '●', label: 'working', color: 'success' },
  idle: { glyph: '○', label: 'idle' },
  unknown: { glyph: '·', label: 'running' },
}

/** What an agent is on: its issue, with title and phase when the issue is known, else its branch. */
const agentDetail = (agent: Agent, issues: readonly OpenIssue[] = []) => {
  if (agent.issueNumber === null) {
    return agent.branch || 'no branch'
  }
  const issue = issues.find(one => one.number === agent.issueNumber)

  return issue
    ? `#${issue.number} ${issue.title} · phase ${Math.min(issue.done + 1, issue.total)}/${issue.total}`
    : `#${agent.issueNumber}${agent.slug ? ` ${agent.slug}` : ''}`
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

const isProject = (value: unknown): value is Project => {
  const one = value as Project | null
  return typeof one?.host === 'string' && typeof one.path === 'string' && (one.forge === 'github' || one.forge === 'gitlab')
}

/** The current repo's project, from `origin`; null outside a repo or without one. */
const currentProject = async ($: EngineInterface): Promise<Project | null> => {
  const remote = parseRemote(await git($, ['remote', 'get-url', 'origin']))
  return remote ? projectFrom(remote.host, remote.path) : null
}

/** The change folder: the branch's slug, else the one naming the branch, else the only active one. */
const readTasks = async ($: EngineInterface, top: string, slug: string, branch: string): Promise<Tasks | null> => {
  const root = `${top}/openspec/changes`
  if (!(await $.fs.exists(root))) {
    return null
  }
  const names = (await $.fs.list(root))
    .filter(entry => entry.kind === 'dir' && entry.name !== 'archive')
    .map(entry => entry.name)
  const texts = new Map<string, string>()
  for (const name of names) {
    const text = await $.fs.read(`${root}/${name}/tasks.md`).catch(() => null)
    if (text !== null) {
      texts.set(name, text)
    }
  }
  const change =
    (slug && texts.has(slug) ? slug : undefined) ??
    (branch ? [...texts].find(([, text]) => text.includes(branch))?.[0] : undefined) ??
    (texts.size === 1 ? [...texts.keys()][0] : undefined)

  return change === undefined ? null : { change, groups: parseTasks(texts.get(change) ?? '') }
}

const readRepo = async ($: EngineInterface): Promise<RepoStatus | null> => {
  const top = await git($, ['rev-parse', '--show-toplevel'])
  if (!top) {
    return null
  }
  const [branch, project] = await Promise.all([git($, ['branch', '--show-current'], top), currentProject($)])
  const { number, slug } = issueFromBranch(branch)
  let issue = null
  let error = null
  if (project && number !== null) {
    try {
      issue = await fetchIssue($, project, number, branch)
    } catch (caught) {
      error = errorText(caught)
    }
  }

  return {
    project,
    name: project ? projectName(project) : (top.split('/').pop() ?? top),
    branch,
    issueNumber: number,
    slug,
    issue,
    tasks: await readTasks($, top, slug, branch).catch(() => null),
    error,
  }
}

const readAll = async ($: EngineInterface, projects: readonly Project[]): Promise<ProjectRow[]> =>
  Promise.all(
    projects.map(async project => {
      try {
        return { project, issues: await fetchOpenIssues($, project), error: null }
      } catch (caught) {
        return { project, issues: [], error: errorText(caught) }
      }
    }),
  )

const taskCount = (tasks: Tasks) => {
  const items = tasks.groups.flatMap(group => group.items)
  return { done: items.filter(item => item.isDone).length, total: items.length }
}

/** `cronista #12 profile-texts · phase 2/4 · tasks 7/15` */
export const bandText = (repo: RepoStatus): string => {
  const parts = [`${repo.name} #${repo.issueNumber}${repo.slug ? ` ${repo.slug}` : ''}`]
  const phases = repo.issue?.phases ?? []
  if (phases.length > 0) {
    const at = currentPhase(phases)
    parts.push(at > phases.length ? `phases done ${phases.length}/${phases.length}` : `phase ${at}/${phases.length}`)
  }
  if (repo.tasks) {
    const { done, total } = taskCount(repo.tasks)
    parts.push(`tasks ${done}/${total}`)
  }
  if (repo.error) {
    parts.push(repo.error)
  }

  return parts.join(' · ')
}

// Module state: a reload starts it over, and session.start runs again after one.
let defaultHost = 'github.com'
let paneColumns = 60
let isRunning = false
let queued: { withAll: boolean } | null = null
let ticker: { cancel: () => void } | null = null
let debounce: { cancel: () => void } | null = null
let agentTicker: { cancel: () => void } | null = null
let isReadingAgents = false
// The current repo's project, and the issue titles known for any project, by mentionKey.
let hereProject: Project | null = null
const titles = new Map<string, string>()
const resolving = new Set<string>()

function mentionProject(mention: Mention): Project | null {
  if (mention.path === null) {
    return hereProject
  }
  return projectFrom(mention.host ?? hereProject?.host ?? defaultHost, mention.path)
}

async function putMention($: EngineInterface, issue: MentionedIssue) {
  const key = mentionKey(issue.project, issue.number)
  await update($, mentionsAtom, list =>
    [issue, ...list.filter(one => mentionKey(one.project, one.number) !== key)].slice(0, MAX_MENTIONS),
  )
}

/** Reads a mentioned issue once; a bare `#N` that names nothing is dropped. */
async function resolveMention($: EngineInterface, project: Project, number: number) {
  const key = mentionKey(project, number)
  if (resolving.has(key)) {
    return
  }
  resolving.add(key)
  try {
    const issue = await fetchIssueSummary($, project, number)
    titles.set(key, issue.title)
    await putMention($, issue)
    $.ui.invalidate('ui.render')
  } catch {
    // Not an issue there, or the forge cannot be read: nothing to list.
  } finally {
    resolving.delete(key)
  }
}

/** Moves known mentions to the top and reads new ones, the first named ending first. */
async function noteMentions($: EngineInterface, mentions: Mention[]) {
  const known = await read($, mentionsAtom)
  const keys = new Set<string>()
  for (const mention of [...mentions].reverse()) {
    const project = mentionProject(mention)
    if (!project || mention.number <= 0) {
      continue
    }
    const key = mentionKey(project, mention.number)
    if (keys.has(key)) {
      continue
    }
    keys.add(key)
    const found = known.find(one => mentionKey(one.project, one.number) === key)
    if (found) {
      await putMention($, found)
    } else {
      void resolveMention($, project, mention.number)
    }
  }
}

/** Re-reads the listed mentions, keeping their order. */
async function refreshMentions($: EngineInterface) {
  const list = await read($, mentionsAtom)
  const fresh = await Promise.all(list.map(one => fetchIssueSummary($, one.project, one.number).catch(() => one)))
  await update($, mentionsAtom, () => fresh)
}

async function learnTitles($: EngineInterface, project: Project) {
  let isNew = false
  for (const [number, title] of await fetchOpenTitles($, project)) {
    const key = mentionKey(project, number)
    isNew ||= titles.get(key) !== title
    titles.set(key, title)
  }
  if (isNew) {
    $.ui.invalidate('ui.render')
  }
}

/** A bare `#N` links only when it is known to be an issue here; `group/repo#N` names its repo. */
const refInfo = (path: string | null, number: number) => {
  const project = path === null ? hereProject : projectFrom(hereProject?.host ?? defaultHost, path)
  if (!project) {
    return undefined
  }
  const title = titles.get(mentionKey(project, number))
  return path === null && !title ? undefined : { url: issueUrl(project, number), title }
}

/** The agent's text since the person's last message, plus the final answer. */
async function noteTurnMentions($: EngineInterface, answer: string) {
  const rows = await $.session.messages().catch(() => [])
  const texts = [answer]
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (!row || (row.role === 'user' && row.text.trim() !== '' && !row.toolResults?.length)) {
      break
    }
    if (row.role === 'assistant') {
      texts.push(row.text)
    }
  }
  await noteMentions($, texts.reverse().flatMap(findMentionsInText))
}

async function refreshAgents($: EngineInterface) {
  if (isReadingAgents) {
    return
  }
  isReadingAgents = true
  try {
    const agents = await readAgents($)
    await update($, agentsAtom, () => agents)
  } catch {
    // Unreadable registry: the last list stays until a read succeeds.
  } finally {
    isReadingAgents = false
  }
}

async function tickAgents($: EngineInterface) {
  if (await read($, paneAtom).catch(() => false)) {
    await refreshAgents($)
  }
}

async function refresh($: EngineInterface, withAll: boolean) {
  queued = { withAll: withAll || (queued?.withAll ?? false) }
  if (isRunning) {
    return
  }
  isRunning = true
  await update($, loadingAtom, () => true)
  try {
    while (queued) {
      const job = queued
      queued = null
      const [repo] = await Promise.all([readRepo($).catch(() => null), refreshAgents($)])
      await update($, repoAtom, () => repo)
      hereProject = repo?.project ?? null
      const isOpen = await read($, paneAtom)
      await Promise.all([
        hereProject ? learnTitles($, hereProject).catch(() => undefined) : undefined,
        isOpen ? refreshMentions($).catch(() => undefined) : undefined,
      ])
      if (job.withAll) {
        const rows = await readAll($, await read($, projectsAtom))
        await update($, allAtom, () => rows)
      }
    }
  } finally {
    isRunning = false
    await update($, loadingAtom, () => false)
  }
}

async function wantsAll($: EngineInterface) {
  return (await read($, paneAtom)) && (await read($, viewAtom)) === 'all'
}

async function openPane($: EngineInterface, view?: View) {
  if (view) {
    await update($, viewAtom, () => view)
    await $.store.set('view', view)
  }
  const placed = await $.ui.open({ id: PANE, title: 'Waypoint', columns: paneColumns })
  await update($, paneAtom, () => true)
  void kick($, (await read($, viewAtom)) === 'all')

  return placed.isPlaced ? 'Waypoint pane opened.' : `Waypoint pane not shown: ${placed.reason}`
}

async function saveProjects($: EngineInterface, projects: Project[]) {
  await $.store.set('projects', projects)
  await update($, projectsAtom, () => projects)
}

async function addProject($: EngineInterface, arg: string) {
  const project = arg ? parseProjectArg(arg, defaultHost) : await currentProject($)
  if (!project) {
    return arg
      ? `Not a project path: ${arg}. Use group/repo, host/group/repo or a URL.`
      : 'This folder has no git remote named origin. Give a path: /where add group/repo'
  }
  const projects = await read($, projectsAtom)
  if (projects.some(one => sameProject(one, project))) {
    return `Already tracked: ${project.host}/${project.path}`
  }
  try {
    await checkProject($, project)
  } catch (caught) {
    return `Cannot read ${project.host}/${project.path}: ${errorText(caught)}`
  }
  await saveProjects($, [...projects, project])
  void kick($)

  return `Tracking ${project.host}/${project.path} (${project.forge}).`
}

async function removeProject($: EngineInterface, arg: string) {
  const projects = await read($, projectsAtom)
  const wanted = arg.toLowerCase().replace(/\.git$/, '')
  const matches = projects.filter(
    one =>
      projectName(one).toLowerCase() === wanted ||
      one.path.toLowerCase() === wanted ||
      `${one.host}/${one.path}`.toLowerCase() === wanted,
  )
  if (matches.length !== 1) {
    return matches.length === 0
      ? `Not tracked: ${arg}. /where list shows the tracked projects.`
      : `${arg} matches ${matches.length} projects; give group/repo.`
  }
  await saveProjects($, projects.filter(one => !matches.includes(one)))
  await update($, allAtom, rows => rows?.filter(row => !matches.some(one => sameProject(one, row.project))) ?? null)

  return `Stopped tracking ${matches[0]?.host}/${matches[0]?.path}.`
}

async function showView($: EngineInterface, view: View) {
  await update($, viewAtom, () => view)
  await $.store.set('view', view)
  if (view === 'all') {
    await refresh($, true)
  }
}

/** A refresh nobody waits on: what it fails on shows at the next one. */
async function kick($: EngineInterface, withAll?: boolean) {
  try {
    await refresh($, withAll ?? (await wantsAll($)))
  } catch {
    // The session or the module ended under it.
  }
}

export const register: Register = (on, options) => {
  defaultHost = typeof options.defaultHost === 'string' && options.defaultHost ? options.defaultHost : 'github.com'
  paneColumns =
    typeof options.paneColumns === 'number' && Number.isInteger(options.paneColumns) && options.paneColumns > 0
      ? options.paneColumns
      : 60

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'where',
      description: 'Where the change stands: phases from the issue, OpenSpec tasks, every tracked project',
      argumentHint: '[repo|all|add [path]|remove <name>|list|refresh]',
    })
    const stored = await $.store.get('projects')
    await update($, projectsAtom, () => (Array.isArray(stored) ? stored.filter(isProject) : []))
    const view = await $.store.get('view')
    await update($, viewAtom, () => (view === 'all' ? 'all' : 'repo'))
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => void kick($))
    agentTicker?.cancel()
    agentTicker = $.clock.every(AGENT_TICK_MS, () => void tickAgents($).catch(() => undefined))
    void kick($, false)

    return started
  })

  on('command.run', { command: 'where' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    switch (sub) {
      case '':
        return { text: await openPane($) }
      case 'repo':
      case 'all':
        return { text: await openPane($, sub) }
      case 'add': {
        // Several paths at once, also when `/where add` lines are pasted together.
        const paths = rest.filter(word => word !== '/where' && word !== 'add')
        if (paths.length <= 1) {
          return { text: await addProject($, paths[0] ?? '') }
        }
        const lines: string[] = []
        for (const path of paths) {
          lines.push(await addProject($, path))
        }
        return { text: lines.join('\n') }
      }
      case 'remove':
      case 'rm':
        return { text: arg ? await removeProject($, arg) : 'Usage: /where remove <name or path>' }
      case 'list': {
        const projects = await read($, projectsAtom)
        return {
          text:
            projects.length === 0
              ? 'No projects tracked yet. /where add tracks the current repo.'
              : projects.map(one => `${projectName(one)}  ${one.host}/${one.path}  (${one.forge})`).join('\n'),
        }
      }
      case 'refresh':
        await refresh($, await wantsAll($))
        return { text: 'Waypoint refreshed.' }
      default:
        return { text: USAGE }
    }
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) {
      await update($, paneAtom, () => false)
    }
    return closed
  })

  // Refresh soon after the agent changes what the band shows.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const command = e.tool === 'Bash' ? e.command : ''
    const file = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : ''
    const url = 'url' in e && typeof e.url === 'string' ? e.url : ''
    const mentions = [...findMentionsInCommand(command, hereProject?.host ?? null), ...findMentionsInText(url)]
    if (mentions.length > 0) {
      void noteMentions($, mentions).catch(() => undefined)
    }
    const isRelevant =
      /\b(gh|glab)\s+(issue|api|mr|pr)\b/.test(command) ||
      /\bgit\s+(checkout|switch|merge|pull|rebase|reset)\b/.test(command) ||
      /(^|\/)tasks\.md$/.test(file)
    if (isRelevant) {
      debounce?.cancel()
      debounce = $.clock.after(1_500, () => void kick($))
    }

    return ran
  })

  // Mentions from every block the agent wrote this turn, read once it ends,
  // so a reference half streamed (`#1` of `#12`) is never looked up.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) {
      void noteTurnMentions($, e.answer).catch(() => undefined)
    }
    return done
  })

  // Links and titles for `#12` in the agent's messages: the drawing only,
  // never the stored message or what the model reads.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props.text
    const annotated = annotateIssues(text, refInfo)
    return annotated === text ? next(e) : next({ ...e, props: { ...e.props, text: annotated } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const repo = await read($, repoAtom)
    if (e.props.hasSurvey || repo === null || repo.issueNumber === null) {
      return next(e)
    }
    const { Text } = $.ui.resolve(e)

    return (
      <Text dimColor wrap="truncate-end">
        {bandText(repo)}
      </Text>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Markdown, Text } = $.ui.resolve(e)
    const [view, repo, all, projects, isLoading, agents, mentions] = await Promise.all([
      read($, viewAtom),
      read($, repoAtom),
      read($, allAtom),
      read($, projectsAtom),
      read($, loadingAtom),
      read($, agentsAtom),
      read($, mentionsAtom),
    ])

    const agentRow = (agent: Agent, detail: string) => {
      const look = AGENT_LOOK[agent.status]
      return (
        <Text key={`agent-${agent.sessionId || agent.cwd}`} color={look.color} dimColor={!look.color} wrap="truncate-end">
          {'  '}
          {look.glyph} {look.label} · {agent.name}
          {agent.isSelf ? ' (this session)' : ''} · {detail}
        </Text>
      )
    }

    const header = (
      <Box flexDirection="row" gap={1}>
        <Button key="view-repo" label="Repo" variant={view === 'repo' ? 'primary' : 'secondary'} onPress={() => showView($, 'repo')} />
        <Button key="view-all" label="All" variant={view === 'all' ? 'primary' : 'secondary'} onPress={() => showView($, 'all')} />
        <Button key="refresh" label="Refresh" plain dimColor onPress={async () => refresh($, view === 'all')} />
        {isLoading && <Text dimColor>refreshing…</Text>}
      </Box>
    )

    // Mentions, in both views; a mention in the current repo reads `#N`, any other `group/repo#N`.
    const herePath = repo?.project ?? null
    const mentionList = mentions.length > 0 && (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Mentioned in this session</Text>
        {mentions.map(issue => {
          const isHere = herePath !== null && sameProject(issue.project, herePath)
          const ref = `${isHere ? '' : issue.project.path}${issue.isPullRequest && issue.project.forge === 'gitlab' ? '!' : '#'}${issue.number}`
          const phase = issue.total > 0 ? ` · phase ${Math.min(issue.done + 1, issue.total)}/${issue.total}` : ''
          return (
            <Box key={`mention-${mentionKey(issue.project, issue.number)}`} flexDirection="row" gap={1}>
              <Link href={issue.url} label={`  ${ref}`} />
              <Text dimColor={issue.state !== 'open' && issue.state !== 'opened'} wrap="truncate-end">
                {issue.isPullRequest ? 'PR ' : ''}
                {issue.title} · {issue.state}
                {phase}
              </Text>
            </Box>
          )
        })}
      </Box>
    )

    if (view === 'all') {
      const here = repo?.project ?? null
      const others = (agents ?? []).filter(
        agent => !agent.project || !projects.some(one => agent.project !== null && sameProject(one, agent.project)),
      )
      return (
        <Box flexDirection="column">
          {header}
          {projects.length === 0 && (
            <Text dimColor>No projects tracked. Run /where add in a repo, or /where add group/repo.</Text>
          )}
          {projects.length > 0 && all === null && <Text dimColor>Loading…</Text>}
          {(all ?? []).map(row => (
            <Box key={`${row.project.host}/${row.project.path}`} flexDirection="column" marginTop={1}>
              <Text bold>
                {projectName(row.project)}
                {here && sameProject(here, row.project) ? '  ← here' : ''}
              </Text>
              {(agents ?? [])
                .filter(agent => agent.project !== null && sameProject(agent.project, row.project))
                .map(agent => agentRow(agent, agentDetail(agent, row.issues)))}
              {row.error && <Text dimColor>  {row.error}</Text>}
              {!row.error && row.issues.length === 0 && <Text dimColor>  nothing in progress</Text>}
              {row.issues.slice(0, 5).map(issue => (
                <Box key={`${row.project.path}#${issue.number}`} flexDirection="row" gap={1}>
                  <Link href={issue.url} label={`  #${issue.number}`} />
                  <Text wrap="truncate-end">
                    {issue.title} · phase {Math.min(issue.done + 1, issue.total)}/{issue.total}
                  </Text>
                </Box>
              ))}
              {row.issues.length > 5 && <Text dimColor>  and {row.issues.length - 5} more</Text>}
            </Box>
          ))}
          {others.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Other sessions</Text>
              {others.map(agent => agentRow(agent, `${agent.repoName} · ${agentDetail(agent)}`))}
            </Box>
          )}
          {mentionList}
        </Box>
      )
    }

    if (repo === null) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>{isLoading ? 'Loading…' : 'Not in a git repository.'}</Text>
        </Box>
      )
    }

    const project = repo.project
    const isTracked = project !== null && projects.some(one => sameProject(one, project))
    const phases = repo.issue?.phases ?? []
    const at = currentPhase(phases)
    const tasks = repo.tasks
    const openGroup = tasks?.groups.find(group => group.items.some(item => !item.isDone))
    const here = (agents ?? []).filter(agent =>
      project !== null && agent.project !== null ? sameProject(agent.project, project) : agent.repoName === repo.name,
    )

    return (
      <Box flexDirection="column">
        {header}
        <Text bold wrap="truncate-end">
          {repo.name}
          {repo.issueNumber !== null ? ` #${repo.issueNumber}` : ''}
          {repo.issue ? ` ${repo.issue.title}` : ` · ${repo.branch || 'detached HEAD'}`}
        </Text>
        {project === null && <Text dimColor>No origin remote: phases need a GitHub or GitLab issue.</Text>}
        {project !== null && repo.issueNumber === null && (
          <Text dimColor>No issue number in the branch name (expected e.g. fix/12-short-name).</Text>
        )}
        {repo.error && <Text dimColor>{repo.error}</Text>}

        {repo.issue && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>
              Phases {phases.filter(phase => phase.isDone).length}/{phases.length}
              {repo.issue.state && repo.issue.state !== 'open' && repo.issue.state !== 'opened' ? ` · issue ${repo.issue.state}` : ''}
            </Text>
            {phases.length === 0 && <Text dimColor>No checklist in the issue description.</Text>}
            {phases.map((phase, index) => (
              <Text key={`phase-${index}`} bold={index + 1 === at} dimColor={phase.isDone} wrap="truncate-end">
                {phase.isDone ? '✓' : index + 1 === at ? '▸' : '·'} {phase.text}
              </Text>
            ))}
          </Box>
        )}

        {tasks && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>
              OpenSpec {tasks.change} · tasks {taskCount(tasks).done}/{taskCount(tasks).total}
            </Text>
            {tasks.groups.map(group => {
              const done = group.items.filter(item => item.isDone).length
              const isOpen = group === openGroup
              return (
                <Box key={`group-${group.title}`} flexDirection="column">
                  <Text bold={isOpen} dimColor={done === group.items.length} wrap="truncate-end">
                    {done === group.items.length ? '✓' : isOpen ? '▸' : '·'} {group.title} {done}/{group.items.length}
                  </Text>
                  {isOpen &&
                    group.items.map((item, index) => (
                      <Text key={`task-${index}`} dimColor={item.isDone} wrap="truncate-end">
                        {'    '}
                        {item.isDone ? '✓' : '○'} {truncate(item.text, 120)}
                      </Text>
                    ))}
                </Box>
              )
            })}
          </Box>
        )}

        {here.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Sessions on this repo</Text>
            {here.map(agent => agentRow(agent, agentDetail(agent)))}
          </Box>
        )}

        {mentionList}

        {repo.issue?.lastComment && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>
              Last comment · {repo.issue.lastComment.author} · {repo.issue.lastComment.at}
            </Text>
            <Markdown key="last-comment" text={truncate(repo.issue.lastComment.body, 600)} />
          </Box>
        )}

        {(repo.issue || (project && !isTracked)) && (
          <Box flexDirection="row" gap={2} marginTop={1}>
            {repo.issue?.url && <Link href={repo.issue.url} label={`Issue #${repo.issue.number}`} />}
            {repo.issue?.mergeRequest && (
              <Link
                href={repo.issue.mergeRequest.url}
                label={`${project?.forge === 'github' ? 'PR' : 'MR'} (${repo.issue.mergeRequest.state})`}
              />
            )}
            {project && !isTracked && (
              <Button key="track" label="Track this repo" onPress={async () => void (await addProject($, ''))} />
            )}
          </Box>
        )}
      </Box>
    )
  })
}
