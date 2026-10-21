import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Project, ProjectRow, RepoStatus, Tasks, View } from '../types'
import { checkProject, fetchIssue, fetchOpenIssues } from './forge'
import {
  currentPhase,
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

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

const isProject = (value: unknown): value is Project => {
  const one = value as Project | null
  return typeof one?.host === 'string' && typeof one.path === 'string' && (one.forge === 'github' || one.forge === 'gitlab')
}

const git = async ($: EngineInterface, args: string[], cwd?: string) => {
  const run = await $.process.run(['git', ...args], cwd ? { cwd } : undefined).catch(() => null)
  return run?.exitCode === 0 ? run.stdout.trim() : ''
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
let isRunning = false
let queued: { withAll: boolean } | null = null
let ticker: { cancel: () => void } | null = null
let debounce: { cancel: () => void } | null = null


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
      const repo = await readRepo($).catch(() => null)
      await update($, repoAtom, () => repo)
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
  const placed = await $.ui.open({ id: PANE, title: 'Waypoint' })
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
      case 'add':
        return { text: await addProject($, arg) }
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
    const [view, repo, all, projects, isLoading] = await Promise.all([
      read($, viewAtom),
      read($, repoAtom),
      read($, allAtom),
      read($, projectsAtom),
      read($, loadingAtom),
    ])

    const header = (
      <Box flexDirection="row" gap={1}>
        <Button key="view-repo" label="Repo" variant={view === 'repo' ? 'primary' : 'secondary'} onPress={() => showView($, 'repo')} />
        <Button key="view-all" label="All" variant={view === 'all' ? 'primary' : 'secondary'} onPress={() => showView($, 'all')} />
        <Button key="refresh" label="Refresh" plain dimColor onPress={async () => refresh($, view === 'all')} />
        {isLoading && <Text dimColor>refreshing…</Text>}
      </Box>
    )

    if (view === 'all') {
      const here = repo?.project ?? null
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
