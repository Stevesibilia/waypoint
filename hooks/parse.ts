// Pure parsing: no `$`, so the tests reach every function directly.

import type { AgentStatus, Check, Forge, Project, TaskGroup } from '../types'

const CHECKBOX = /^(\s*)[-*+] \[([ xX])\] (.+)$/
const FENCE = /^\s*(```|~~~)/

/** Checkboxes outside code fences; `topLevel` keeps only unindented ones. */
export const parseChecklist = (text: string, topLevel = true): Check[] => {
  const checks: Check[] = []
  let isFenced = false

  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      isFenced = !isFenced
      continue
    }
    const match = isFenced ? null : CHECKBOX.exec(line)
    if (match && (!topLevel || (match[1] ?? '').length < 2)) {
      checks.push({ text: (match[3] ?? '').trim(), isDone: match[2] !== ' ' })
    }
  }

  return checks
}

/** The phases of an issue: its `Phase …` lines when it has any, else every checkbox. */
export const parsePhases = (body: string): Check[] => {
  const checks = parseChecklist(body)
  const named = checks.filter(check => /^phase\b/i.test(check.text))

  return named.length > 0 ? named : checks
}

/** An OpenSpec `tasks.md`: each `## ` heading with every checkbox under it. */
export const parseTasks = (text: string): TaskGroup[] => {
  const groups: TaskGroup[] = []
  let current: TaskGroup | null = null

  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) {
      current = { title: (heading[1] ?? '').trim(), items: [] }
      groups.push(current)
      continue
    }
    const [check] = parseChecklist(line, false)
    if (check) {
      if (!current) {
        current = { title: 'Tasks', items: [] }
        groups.push(current)
      }
      current.items.push(check)
    }
  }

  return groups.filter(group => group.items.length > 0)
}

/** `fix/12-profile-texts` → 12 and `profile-texts`; no leading number, no issue. */
export const issueFromBranch = (branch: string): { number: number | null; slug: string } => {
  const last = branch.split('/').pop() ?? branch
  const match = /^#?(\d+)(?:[-_](.*))?$/.exec(last)

  return match
    ? { number: Number(match[1]), slug: match[2] ?? '' }
    : { number: null, slug: last }
}

/** The host and repository path of a git remote, scp-like or URL. */
export const parseRemote = (remote: string): { host: string; path: string } | null => {
  const url = remote.trim()
  const scp = /^[\w.-]+@([^:/]+):(?!\/)(.+)$/.exec(url)
  if (scp) {
    return clean(scp[1] ?? '', scp[2] ?? '')
  }
  try {
    const parsed = new URL(url)

    return clean(parsed.hostname, parsed.pathname)
  } catch {
    return null
  }
}

const clean = (host: string, path: string) => {
  const trimmed = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')

  return host && trimmed.includes('/') ? { host: host.toLowerCase(), path: trimmed } : null
}

export const forgeOf = (host: string): Forge => (/(^|\.)github\./.test(host) ? 'github' : 'gitlab')

export const projectFrom = (host: string, path: string): Project => ({
  forge: forgeOf(host),
  host,
  path,
})

/** `/where add` argument: a URL, `host/group/repo`, or `group/repo` on `defaultHost`. */
export const parseProjectArg = (arg: string, defaultHost: string): Project | null => {
  const text = arg.trim()
  if (!text) {
    return null
  }
  const remote = parseRemote(text.includes('://') || /^[\w.-]+@/.test(text) ? text : `https://${text}`)
  if (remote && remote.host.includes('.')) {
    return projectFrom(remote.host, remote.path)
  }
  const path = text.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')

  return path.includes('/') ? projectFrom(defaultHost.toLowerCase(), path) : null
}

export const projectName = (project: Project): string => project.path.split('/').pop() ?? project.path

export const sameProject = (a: Project, b: Project): boolean =>
  a.host === b.host && a.path.toLowerCase() === b.path.toLowerCase()

/** Which phase is current: the first unchecked one, 1-based; past the end when all are done. */
export const currentPhase = (phases: readonly Check[]): number => {
  const open = phases.findIndex(phase => !phase.isDone)

  return open === -1 ? phases.length + 1 : open + 1
}

export type RegistryEntry = { pid: number; sessionId: string; cwd: string; status: AgentStatus; name: string }

const STATUSES: Record<string, AgentStatus> = { busy: 'working', waiting: 'waiting', idle: 'idle' }

/**
 * One `~/.claude/sessions/<pid>.json`. The format is Claude Code's own and
 * undocumented, so every field is optional: what is missing reads as unknown.
 */
export const parseRegistryEntry = (text: string): RegistryEntry | null => {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  const pid = Number(raw.pid)
  const cwd = typeof raw.cwd === 'string' ? raw.cwd : ''
  if (!Number.isInteger(pid) || pid <= 0 || !cwd) {
    return null
  }
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : ''

  return {
    pid,
    sessionId,
    cwd,
    status: STATUSES[String(raw.status)] ?? 'unknown',
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : sessionId.slice(0, 8) || `pid ${pid}`,
  }
}

/** An issue named somewhere; `host` and `path` null mean the current repo's. */
export type Mention = { host: string | null; path: string | null; number: number }

const GITHUB_URL = /https?:\/\/([\w.-]*github[\w.-]*)\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/g
const GITLAB_URL = /https?:\/\/([\w.-]+)\/((?:[\w.-]+\/)+[\w.-]+)\/-\/(?:issues|work_items)\/(\d+)/g
const QUALIFIED = /(?<![\w/.-])([\w.-]+(?:\/[\w.-]+)+)#(\d{1,6})(?!\w)/g
const BARE = /(?<![\w&/.#-])#(\d{1,6})(?!\w)/g
const CLI_ISSUE = /\b(gh|glab)\s+(?:issue|pr|mr)\s+(?:view|edit|comment|note|close|reopen|update|checkout|diff|merge|subscribe)\s+(\d+)/
const CLI_REPO = /(?:-R|--repo)[ =]["']?([^\s"']+)/
const GH_API = /\brepos\/([\w.-]+\/[\w.-]+)\/(?:issues|pulls)\/(\d+)/
const GLAB_API = /\bprojects\/([^/\s"']+)\/(?:issues|merge_requests)\/(\d+)/
const API_HOST = /--hostname[ =]["']?([\w.-]+)/

/** Text with fenced blocks and inline code blanked out, so `#1` in code is no mention. */
const prose = (text: string) => {
  let isFenced = false

  return text
    .split('\n')
    .map(line => {
      if (FENCE.test(line)) {
        isFenced = !isFenced
        return ''
      }
      return isFenced ? '' : line.replace(/`[^`]*`/g, '')
    })
    .join('\n')
}

const urlMentions = (text: string): Mention[] => [
  ...[...text.matchAll(GITHUB_URL)].map(m => ({ host: (m[1] ?? '').toLowerCase(), path: m[2] ?? '', number: Number(m[3]) })),
  ...[...text.matchAll(GITLAB_URL)].map(m => ({ host: (m[1] ?? '').toLowerCase(), path: m[2] ?? '', number: Number(m[3]) })),
]

/** Issues named in what the agent wrote: URLs, `group/repo#12`, and bare `#12`. */
export const findMentionsInText = (text: string): Mention[] => {
  const plain = prose(text)
  const withoutUrls = plain.replace(/https?:\/\/\S+/g, '')

  return [
    ...urlMentions(plain),
    ...[...withoutUrls.matchAll(QUALIFIED)].map(m => ({ host: null, path: m[1] ?? '', number: Number(m[2]) })),
    ...[...withoutUrls.matchAll(BARE)].map(m => ({ host: null, path: null, number: Number(m[1]) })),
  ]
}

/** Issues a `gh` or `glab` command reads or changes, and issue URLs in it. */
export const findMentionsInCommand = (command: string, defaultHost: string | null = null): Mention[] => {
  const found = urlMentions(command)
  const cli = CLI_ISSUE.exec(command)
  if (cli) {
    const repo = CLI_REPO.exec(command)?.[1]
    const project = repo ? parseProjectArg(repo, defaultHost ?? 'github.com') : null
    found.push({
      host: project && repo?.split('/').length !== 2 ? project.host : null,
      path: project?.path ?? null,
      number: Number(cli[2]),
    })
  }
  const host = API_HOST.exec(command)?.[1]?.toLowerCase() ?? null
  const gh = GH_API.exec(command)
  if (gh && /\bgh\s+api\b/.test(command)) {
    found.push({ host: host ?? 'github.com', path: gh[1] ?? '', number: Number(gh[2]) })
  }
  const gl = GLAB_API.exec(command)
  if (gl && /\bglab\s+api\b/.test(command) && gl[1] !== ':id') {
    found.push({ host, path: decodeURIComponent(gl[1] ?? ''), number: Number(gl[2]) })
  }

  return found
}

/** Whether the text after a reference already names the issue, as in `#34 Editable document templates`. */
const startsWithTitle = (after: string, title: string) => {
  const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const head = words(title).slice(0, 16)

  return head.length > 0 && words(after.slice(0, title.length + 8)).startsWith(head)
}

/** The web page of issue `number`; GitHub sends a PR's number on to the PR. */
export const issueUrl = (project: Project, number: number): string =>
  project.forge === 'github'
    ? `https://${project.host}/${project.path}/issues/${number}`
    : `https://${project.host}/${project.path}/-/issues/${number}`

/** What the display knows of a reference: where it links, and its title. */
export type RefInfo = { url?: string; title?: string }

// A reference, `group/repo#12` or bare `#12`, as the display rewrites it.
const REF = /(?<![\w&/.#-])(?:([\w.-]+(?:\/[\w.-]+)+))?#(\d{1,6})(?!\w)/g
// Left as written: inline code, Markdown links, URLs.
const KEEP = /(`[^`]*`|\[[^\]]*\]\([^)]*\)|https?:\/\/[^\s)>\]]+)/

/**
 * `#12` → `[#12](url) (title)` outside code, links and URLs: the link where
 * `lookup` gives a URL, the title where it gives one and the text after the
 * reference does not already name the issue or open a parenthesis.
 */
export const annotateIssues = (text: string, lookup: (path: string | null, number: number) => RefInfo | undefined): string => {
  let isFenced = false

  return text
    .split('\n')
    .map(line => {
      if (FENCE.test(line)) {
        isFenced = !isFenced
        return line
      }
      if (isFenced) {
        return line
      }
      return line
        .split(KEEP)
        .map((part, index) =>
          index % 2 === 1
            ? part
            : part.replace(REF, (whole: string, path: string | undefined, digits: string, offset: number, all: string) => {
                const info = lookup(path ?? null, Number(digits))
                if (!info) {
                  return whole
                }
                const after = all.slice(offset + whole.length)
                const link = info.url ? `[${whole}](${info.url})` : whole
                const title = info.title
                const hasTitle = !title || /^\s*\(/.test(after) || startsWithTitle(after, title)
                return hasTitle ? link : `${link} (${title.length > 48 ? `${title.slice(0, 47).trimEnd()}…` : title})`
              }),
        )
        .join('')
    })
    .join('\n')
}
