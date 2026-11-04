# CLAUDE.md

Guidance for Claude Code in this repository.

The shared agent instructions (commands, code map, rules, definition of done)
live in AGENTS.md so every AI tool reads the same source — they are imported here:

@AGENTS.md

Domain knowledge (roles, lifecycle, statuses, blockchain stages):

@knowledge.md

## Claude-specific notes

- Skills are **optional and local**. `.claude/` and `skills-lock.json` aren't in this repository, so a fresh clone won't have the skills below. Nothing needs them: AGENTS.md has every command, rule and the definition of done. If a skill isn't available, follow AGENTS.md instead.
- Project skills, if `.claude/skills/` exists on your machine:
  - `procurement-transition` — step-by-step recipe for adding or changing a procurement status transition (model → view → notify → audit → anchor → API wrapper → UI → tests).
  - `preflight-check` — the no-regressions checklist to run before committing or pushing (tests, migrations check, frontend build, secret scan).
- Third-party skills (install with `npx skills add`; a local `skills-lock.json` records them):
  - `vercel-react-best-practices`, `web-design-guidelines` — from `vercel-labs/agent-skills` (React performance rules, UI/accessibility review). The Next.js-specific rules don't apply; this is a Vite SPA.
  - `frontend-design`, `webapp-testing` — from `anthropics/skills` (UI design guidance, Playwright testing against the local app).
- Prefer reading `backend/procurement/blockchain.py` docstrings before changing anything anchor-related; they document past bugs (e.g. why `PAYLOAD_VERSION` is 2).
- The shell is Windows (PowerShell / Git Bash). The backend venv Python is `backend/venv/Scripts/python`.
- Don't push to `main` or trigger deploys without the user asking — `main` is wired to Render and Vercel.
