# waypoint

A Claude Code mod that shows where a change stands, inside the session. A big change is split into phases. Waypoint answers "which phase are we in, what's left" for the current repo and for every project you track.

```text
cronista #12 profile-texts · phase 2/4 · tasks 7/15
```

## What it shows

- **A band above the prompt** with the issue, the current phase and the OpenSpec task count. It shows when the branch name starts with an issue number, such as `fix/12-profile-texts`.
- **A pane** (`/where`) with two views, switched by the `Repo` and `All` buttons:
  - **Repo**: the issue's phases, the OpenSpec task groups with the open one expanded, the last issue comment, and links to the issue and its PR or MR.
  - **All**: every tracked project with its open issues that have unfinished phases.

It refreshes every minute, and soon after the agent runs `gh` or `glab` on issues, switches branch, or edits a `tasks.md`.

## Where the data comes from

- **Phases** are a checklist in the issue description. When the list has `Phase …` lines, only those count; otherwise every checkbox does.

  ```markdown
  - [x] Phase 1: schema
  - [ ] Phase 2: rendering
  - [ ] Phase 3: frontend
  ```

- **Tasks** come from the OpenSpec change's `openspec/changes/<change>/tasks.md`. The change is the folder named like the branch (`profile-texts`), else the one whose `tasks.md` names the branch, else the only active change.
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

| Command | What it does |
| --- | --- |
| `/where` | Open the pane on the last view used |
| `/where repo`, `/where all` | Open it on the current repo, or on every tracked project |
| `/where add` | Track the current repo |
| `/where add <path>` | Track `group/repo` on the default host, `host/group/repo`, or a URL |
| `/where remove <name>` | Stop tracking a project, by name or path |
| `/where list` | List the tracked projects |
| `/where refresh` | Refresh now |

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
