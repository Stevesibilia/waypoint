// Pure parsing: no `$`, so the tests reach every function directly.

import type { Check, Forge, Project, TaskGroup } from '../types'

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
