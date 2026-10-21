// Live Claude Code sessions on this machine, read the way they are left on
// disk: the registry Claude Code keeps per process, `ps` for liveness, and git
// for each session's branch. Transcripts are never read, so no prompt or
// command reaches waypoint.

import type { EngineInterface } from 'claude-code'

import type { Agent, Project } from '../types'
import { issueFromBranch, parseRegistryEntry, parseRemote, projectFrom, projectName } from './parse'

type RepoInfo = { top: string; branch: string; project: Project | null }

const REPO_TTL_MS = 60_000
const ORDER = { waiting: 0, working: 1, idle: 2, unknown: 3 } as const

// A session's folder rarely changes branch between two 5 s reads.
const repoCache = new Map<string, { at: number; info: RepoInfo | null }>()

export async function git($: EngineInterface, args: string[], cwd?: string) {
  const run = await $.process.run(['git', ...args], cwd ? { cwd } : undefined).catch(() => null)
  return run?.exitCode === 0 ? run.stdout.trim() : ''
}

async function repoInfo($: EngineInterface, cwd: string, now: number): Promise<RepoInfo | null> {
  const cached = repoCache.get(cwd)
  if (cached && now - cached.at < REPO_TTL_MS) {
    return cached.info
  }
  const [top = '', head = ''] = (await git($, ['-C', cwd, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'])).split('\n')
  let info: RepoInfo | null = null
  if (top) {
    const remote = parseRemote(await git($, ['-C', cwd, 'remote', 'get-url', 'origin']))
    info = { top, branch: head === 'HEAD' ? '' : head, project: remote ? projectFrom(remote.host, remote.path) : null }
  }
  repoCache.set(cwd, { at: now, info })

  return info
}

/**
 * The pids still running, less Claude Code's own `bg-spare` processes: spares
 * kept warm for the next background session, not agents. When `ps` cannot
 * answer, every pid counts as alive.
 */
async function alivePids($: EngineInterface, pids: number[]): Promise<Set<number>> {
  if (pids.length === 0) {
    return new Set()
  }
  const run = await $.process.run(['ps', '-o', 'pid=,command=', '-p', pids.join(',')]).catch(() => null)
  if (run === null) {
    return new Set(pids)
  }

  return new Set(
    run.stdout
      .split('\n')
      .map(line => /^\s*(\d+)\s+(.*)$/.exec(line))
      .filter(match => match !== null && !/\bbg-spare\b/.test(match[2] ?? ''))
      .map(match => Number(match?.[1])),
  )
}

export async function readAgents($: EngineInterface): Promise<Agent[]> {
  const home = await $.env.get('HOME')
  const dir = `${home}/.claude/sessions`
  if (!home || !(await $.fs.exists(dir))) {
    return []
  }
  // Only `<pid>.json`: the `.key` files beside them are never opened.
  const names = (await $.fs.list(dir)).filter(entry => entry.kind === 'file' && /^\d+\.json$/.test(entry.name))
  const entries = (
    await Promise.all(names.map(async entry => parseRegistryEntry(await $.fs.read(`${dir}/${entry.name}`).catch(() => ''))))
  ).filter(entry => entry !== null)
  const alive = await alivePids($, entries.map(entry => entry.pid))
  const selfId = await $.session.id().catch(() => '')
  const now = await $.clock.now()

  const agents = await Promise.all(
    entries
      .filter(entry => alive.has(entry.pid))
      .map(async (entry): Promise<Agent> => {
        const info = await repoInfo($, entry.cwd, now)
        const { number, slug } = issueFromBranch(info?.branch ?? '')

        return {
          sessionId: entry.sessionId,
          name: entry.name,
          status: entry.status,
          cwd: entry.cwd,
          project: info?.project ?? null,
          repoName: info?.project ? projectName(info.project) : ((info?.top ?? entry.cwd).split('/').pop() ?? entry.cwd),
          branch: info?.branch ?? '',
          issueNumber: number,
          slug,
          isSelf: entry.sessionId !== '' && entry.sessionId === selfId,
        }
      }),
  )

  return agents.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.repoName.localeCompare(b.repoName))
}
