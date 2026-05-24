## SOP

Our SOP (Standard Operating Procedure) for work is as follows:

**Always follow this SOP. Skip asking about planning — execute directly unless the user explicitly requests a plan.**

1. Please review HANDOFF.md
1. Assess if a new branch is necessary, if so, create it and check it out. A new branch is almost always preferred.
1. Execute directly against the prompt (skip planning unless explicitly requested)
1. If planning is requested: plan the implementation and request confirmation before proceeding
1. Ask if testing with Playwright is desired. If so, create and execute the tests. Only run the entire suite if asked or if you feel the current work deems it necessary.
1. If bugs are found, recap bugs and ask if fixing the bugs is desired. If so, iterate until all tests pass
1. When all work is completed, report back. Do not merge into `main`, push to the repo, or delete the WIP branch without authorization.
1. No need for PRs — when the work is approved merge the WIP branch into the `main` branch, push the `main` branch to the repo, and delete the WIP branch.

## Session close-out (required)

At the end of every working session, before stopping:

1. **Rewrite** `HANDOFF.md` — not append. Replace the entire contents with:
   - Last updated date
   - Active issue and current status
   - Any decisions made this session that affect future work
   - Next issue(s) in priority order
   - Any live gotchas or blockers

2. Keep it short. HANDOFF.md should never exceed ~30 lines. If you're tempted to write more, you're logging — don't. Completed work belongs in commit messages and closed issues, not here.

3. Remember to close the related issue in Github with a moderately brief summary of important information as the comment. Do not skip this step.

**If Jacob closes/merges manually:**
When starting a new session, check HANDOFF.md and cross-reference with `gh issue list --repo JacobGiordano/kitchen-sync` to catch anything closed manually that isn't reflected yet. Update HANDOFF.md before starting new work if it appears stale.

**The rule:** HANDOFF.md is a whiteboard. Erase and rewrite every session. Git is the log.
