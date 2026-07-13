## SOP

**Always follow this SOP. Skip asking about planning — execute directly unless the user explicitly requests a plan.**

### Session start

1. Pull `main` and check for changes in `HANDOFF.md` before doing anything else.
2. Review `HANDOFF.md` for current status and active issues.
3. Cross-reference with `gh issue list --repo JacobGiordano/kitchen-sync` to catch anything closed manually that isn't reflected yet. Update `HANDOFF.md` if it appears stale.

### Execution

4. Assess if a new branch is necessary and create it. A new branch is almost always preferred.
5. Execute directly against the prompt (skip planning unless explicitly requested).
6. If planning is requested: plan the implementation and request confirmation before proceeding.
7. Ask if testing with Playwright is desired. If so, create and execute the tests. Only run the entire suite if asked or if the current work warrants it.
8. If bugs are found, recap them and ask if fixing them is desired. Iterate until all tests pass.

### Session close-out (required)

9. When all work is completed, report back. Do not merge into `main`, push to the repo, or delete the WIP branch without authorization.
10. Once approved: merge the WIP branch into `main`, push `main` to the repo, and delete the WIP branch. No PRs needed.
11. Close the related GitHub issue with a brief summary of important decisions or outcomes. Do not skip this step.
12. **Rewrite** `HANDOFF.md` — not append. Replace the entire contents with:
    - Last updated date
    - Active issue and current status
    - Any decisions made this session that affect future work
    - Next issue(s) in priority order
    - Any live gotchas or blockers

Keep `HANDOFF.md` under ~30 lines. If you're tempted to write more, you're logging — don't. Completed work belongs in commit messages and closed issues.

**The rule:** `HANDOFF.md` is a whiteboard. Erase and rewrite every session. Git is the log.
