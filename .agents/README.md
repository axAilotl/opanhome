This directory holds repo-local agent state and workspace-specific agent assets.

- `.agents/hermes/` is the repo-local `HERMES_HOME` used by `./hermes`.
  It is intentionally gitignored because it contains local config, sessions,
  logs, and secrets shims.
- `.agents/skills/` is a workspace-local skills directory. Recent Hermes builds
  discover skills from `.agents/skills/` in addition to the standard
  `~/.hermes/skills/` location.
