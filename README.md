# waypoint

A Claude Code mod that shows where a change stands, inside the session. A big change is split into phases. Waypoint answers "which phase are we in, what's left" for the current repo and for every project you track.

```text
cronista #12 profile-texts · phase 2/4 · tasks 7/15
```

## What it shows

- **A band above the prompt** with the issue, the current phase and the OpenSpec task count. It shows when the branch name starts with an issue number, such as `fix/12-profile-texts`.
- **A pane** (`/where`) with two views, switched by the `Repo` and `All` buttons:
  - **Repo**: the issue's phases, the OpenSpec task groups with the open one expanded, the Claude Code sessions working on this repo, the issues mentioned in this session, the last issue comment, and links to the issue and its PR or MR.
  - **All**: every tracked project with its live sessions and its open issues that have unfinished phases, then the sessions in repos you don't track.
- **Live agents**: every Claude Code session running on this machine, with its status (`needs you`, `working`, `idle`) and the issue and phase its branch points at:

  ```text
  rpg-promptbook
    ● working · implementer · #31 Make warnings and errors dismissable · phase 2/4
  ```

- **Issue titles beside `#N`** in the agent's messages: "Next: #12, #11" shows as "Next: #12 (TLS to the database), #11 (Sign-in throttle)". Only the display changes; the stored message and what the model reads stay as written.

It refreshes every minute, every 5 seconds for the agents while the pane is open, and soon after the agent runs `gh` or `glab` on issues, switches branch, or edits a `tasks.md`.

## Where the data comes from

- **Phases** are a checklist in the issue description. When the list has `Phase …` lines, only those count; otherwise every checkbox does.

  ```markdown
  - [x] Phase 1: schema
  - [ ] Phase 2: rendering
  - [ ] Phase 3: frontend
  ```

- **Tasks** come from the OpenSpec change's `openspec/changes/<change>/tasks.md`. The change is the folder named like the branch (`profile-texts`), else the one whose `tasks.md` names the branch, else the only active change.
- **Agents** come from `~/.claude/sessions/<pid>.json`, the registry Claude Code keeps for each running process (its folder and status), with `ps` to drop processes that have exited and git for each folder's branch. Session transcripts are never read, so no prompt or command reaches waypoint. The registry format is Claude Code's own and undocumented: a field it stops writing shows as unknown.
- **Mentions** are issues the agent names in this session: `#12`, `group/repo#12` and issue URLs in its messages (outside code), and issues a `gh` or `glab` command reads or changes. A bare `#N` that is not an issue in the current repo is dropped.
- **GitHub** is read with `gh api`, **GitLab** (gitlab.com or self-hosted) with `glab api --hostname <host>`. The host comes from the repo's `origin` remote. Waypoint stores no tokens: each CLI uses its own login.

## Requirements

- Claude Code with mod (function hooks) support.
- `gh` logged in for GitHub projects, `glab` logged in to each GitLab host you use.

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install waypoint --marketplace Stevesibilia/waypoint
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```bash
claude plugin install waypoint --marketplace Stevesibilia/waypoint
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Stevesibilia/waypoint`, then Add plugin.

## Commands

| Command                     | What it does                                                        |
| --------------------------- | ------------------------------------------------------------------- |
| `/where`                    | Open the pane on the last view used                                 |
| `/where repo`, `/where all` | Open it on the current repo, or on every tracked project            |
| `/where add`                | Track the current repo                                              |
| `/where add <path>`         | Track `group/repo` on the default host, `host/group/repo`, or a URL |
| `/where remove <name>`      | Stop tracking a project, by name or path                            |
| `/where list`               | List the tracked projects                                           |
| `/where refresh`            | Refresh now                                                         |

Each user's project list is kept in the mod's own store, across sessions.

## Settings

`defaultHost` (in `/config`): the host `/where add group/repo` uses when no host is given. Defaults to `github.com`; set it to your GitLab host if most of your projects live there.

## Development

```bash
claude --plugin-dir /path/to/waypoint   # loads the mod, reloads on save
claude plugin validate .
claude plugin test .
```

## License

MIT
