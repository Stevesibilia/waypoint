export type Forge = 'github' | 'gitlab'

/** A repository on a forge: `path` is `owner/repo` or `group/sub/repo`. */
export type Project = { forge: Forge; host: string; path: string }

/** One `- [ ]` / `- [x]` line. */
export type Check = { text: string; isDone: boolean }

/** A `## ` section of an OpenSpec `tasks.md` and the checkboxes under it. */
export type TaskGroup = { title: string; items: Check[] }

export type Tasks = { change: string; groups: TaskGroup[] }

export type Comment = { author: string; at: string; body: string }

export type Link = { url: string; title: string; state: string }

export type Issue = {
  number: number
  title: string
  url: string
  state: string
  phases: Check[]
  lastComment: Comment | null
  mergeRequest: Link | null
}

/** What the current repo's branch points at. */
export type RepoStatus = {
  project: Project | null
  name: string
  branch: string
  issueNumber: number | null
  slug: string
  issue: Issue | null
  tasks: Tasks | null
  error: string | null
}

/** An open issue with a checklist not yet done, for the cross-project view. */
export type OpenIssue = {
  number: number
  title: string
  url: string
  done: number
  total: number
}

export type ProjectRow = { project: Project; issues: OpenIssue[]; error: string | null }

export type View = 'repo' | 'all'

/** An issue or PR the agent named in this session, as last read. */
export type MentionedIssue = {
  project: Project
  number: number
  title: string
  state: string
  url: string
  isPullRequest: boolean
  done: number
  total: number
}

/** Claude Code's own status from its session registry: busy, waiting (needs the person), idle. */
export type AgentStatus = 'working' | 'waiting' | 'idle' | 'unknown'

/** A live Claude Code session on this machine, and the issue its branch points at. */
export type Agent = {
  sessionId: string
  name: string
  status: AgentStatus
  cwd: string
  project: Project | null
  repoName: string
  branch: string
  issueNumber: number | null
  slug: string
  /** The OpenSpec change in the agent's own folder, counted. */
  tasks: { change: string; done: number; total: number } | null
  isSelf: boolean
}

declare module 'claude-code' {
  interface PluginState {
    waypoint: {
      repo: RepoStatus | null
      all: ProjectRow[] | null
      view: View
      projects: Project[]
      agents: Agent[] | null
      mentions: MentionedIssue[]
      isLoading: boolean
      /** Kept here, not in the module, so a reload knows the pane is still open. */
      isPaneOpen: boolean
    }
  }
}
