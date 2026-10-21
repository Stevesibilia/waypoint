// GitHub through `gh api`, GitLab through `glab api`: each CLI keeps its own
// login, so waypoint holds no token.

import type { EngineInterface } from 'claude-code'

import type { Comment, Issue, Link, OpenIssue, Project } from '../types'
import { parsePhases } from './parse'

type Json = Record<string, unknown>

const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''

async function api($: EngineInterface, project: Project, endpoint: string): Promise<unknown> {
  const argv =
    project.forge === 'github'
      ? ['gh', 'api', ...(project.host === 'github.com' ? [] : ['--hostname', project.host]), endpoint]
      : ['glab', 'api', '--hostname', project.host, endpoint]
  const run = await $.process.run(argv, { timeoutMs: 20_000 }).catch(() => {
    throw new Error(`${argv[0]} not found: install it and log in to ${project.host}`)
  })
  if (run.exitCode !== 0) {
    throw new Error(`${argv[0]}: ${firstLine(run.stderr) || `exit ${run.exitCode}`}`)
  }

  return JSON.parse(run.stdout)
}

const gitlabId = (project: Project) => `projects/${encodeURIComponent(project.path)}`

const text = (value: unknown) => (typeof value === 'string' ? value : '')

const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : [])

/** Throws when the project cannot be read, so `/where add` refuses a typo. */
export async function checkProject($: EngineInterface, project: Project): Promise<void> {
  await api($, project, project.forge === 'github' ? `repos/${project.path}` : gitlabId(project))
}

export async function fetchIssue(
  $: EngineInterface,
  project: Project,
  number: number,
  branch: string,
): Promise<Issue> {
  if (project.forge === 'github') {
    const repo = `repos/${project.path}`
    const owner = project.path.split('/')[0] ?? ''
    const issue = (await api($, project, `${repo}/issues/${number}`)) as Json
    const count = Number(issue.comments ?? 0)
    const [comments, pulls] = await Promise.all([
      count === 0
        ? []
        : api($, project, `${repo}/issues/${number}/comments?per_page=100&page=${Math.ceil(count / 100)}`),
      api($, project, `${repo}/pulls?state=all&per_page=1&head=${encodeURIComponent(`${owner}:${branch}`)}`),
    ])
    const last = list(comments).at(-1)
    const pull = list(pulls)[0]

    return {
      number,
      title: text(issue.title),
      url: text(issue.html_url),
      state: text(issue.state),
      phases: parsePhases(text(issue.body)),
      lastComment: last ? toComment(text((last.user as Json)?.login), last) : null,
      mergeRequest: pull ? toLink(pull, pull.merged_at ? 'merged' : text(pull.state)) : null,
    }
  }

  const base = gitlabId(project)
  const [issue, notes, merges] = await Promise.all([
    api($, project, `${base}/issues/${number}`),
    api($, project, `${base}/issues/${number}/notes?sort=desc&order_by=created_at&per_page=20`),
    api($, project, `${base}/merge_requests?source_branch=${encodeURIComponent(branch)}&per_page=1`),
  ])
  const raw = issue as Json
  const note = list(notes).find(one => one.system !== true)
  const merge = list(merges)[0]

  return {
    number,
    title: text(raw.title),
    url: text(raw.web_url),
    state: text(raw.state),
    phases: parsePhases(text(raw.description)),
    lastComment: note ? toComment(text((note.author as Json)?.username), note) : null,
    mergeRequest: merge ? toLink(merge, text(merge.state)) : null,
  }
}

/** Open issues whose checklist is started or pending, most recently updated first. */
export async function fetchOpenIssues($: EngineInterface, project: Project): Promise<OpenIssue[]> {
  const issues =
    project.forge === 'github'
      ? list(await api($, project, `repos/${project.path}/issues?state=open&sort=updated&per_page=50`)).filter(
          one => one.pull_request === undefined,
        )
      : list(await api($, project, `${gitlabId(project)}/issues?state=opened&order_by=updated_at&per_page=50`))

  return issues.flatMap(one => {
    const phases = parsePhases(text(one.body ?? one.description))
    const done = phases.filter(phase => phase.isDone).length

    return phases.length === 0 || done === phases.length
      ? []
      : [
          {
            number: Number(one.number ?? one.iid),
            title: text(one.title),
            url: text(one.html_url ?? one.web_url),
            done,
            total: phases.length,
          },
        ]
  })
}

const toComment = (author: string, raw: Json): Comment => ({
  author,
  at: text(raw.created_at).slice(0, 10),
  body: text(raw.body),
})

const toLink = (raw: Json, state: string): Link => ({
  url: text(raw.html_url ?? raw.web_url),
  title: text(raw.title),
  state,
})
