# Standard Operating Procedure

This SOP applies to every agent in every session. No exceptions.

---

## Session start

1. **Pull main**: `git checkout main && git pull origin main`
2. **Read HANDOFF.md**: understand the current phase and what's in flight
3. **Reconcile open issues**: run `gh issue list` (or equivalent) and compare with HANDOFF.md — flag any discrepancies to the user before proceeding
4. **Activate the correct agent**: do not work without an agent profile loaded
5. **Branch check**: confirm you are on the issue branch, not `main`
   - If no branch exists: `git checkout -b <issue-branch-name>`
   - Branch naming: `<issue-number>-short-description`

---

## During work

- **One issue per session**: complete the issue, verify it, report back, and stop. Do not start a second issue without explicit user authorization.
- **Stay in your directory**: never modify files outside your assigned ownership area
- **Shared contract changes**: do not touch the shared contract file unilaterally — coordinate with Arch first
- **No push, no close, no HANDOFF edit** until the user says "ship it"

---

## Done state (before "ship it")

1. Run lint and build — both must pass
2. Run the test suite — all tests must pass
3. Verify the feature works in the running application (for UI or API changes)
4. Merge the issue branch to local `main`: `git checkout main && git merge <issue-branch>`
5. Report back to the user with:
   - What was built
   - Any deviations from the spec and why
   - Any follow-on tickets that should be opened
   - Whether a Rune security review is recommended
6. **STOP** — do not push, do not close the issue, do not edit HANDOFF.md

---

## Ship it (triggered by user)

Only after the user explicitly says "ship it" (or equivalent authorization):

1. Rewrite HANDOFF.md to reflect current state — this is the first commit of the ship step
2. Close the GitHub issue
3. Push main to remote: `git push origin main`
4. Delete the WIP branch: `git branch -d <issue-branch>`

---

## Flint gate

Before any phase advances, Coda calls Flint to verify all acceptance criteria are genuinely met — not nominally checked off.

Flint's verdict:
- **READY TO ADVANCE**: the phase gate passes; Phase N+1 work may begin
- **NEEDS WORK**: specific failures listed; fixes required before re-check

---

## Parallel agent execution

When Coda runs two agents simultaneously:
- Each agent must be in a separate git worktree (`git worktree add`)
- Agents must not share uncommitted state
- Each agent merges to its own local branch; Coda sequences the merges

---

## Anti-patterns (never do these)

- Modifying files outside your ownership area without authorization
- Skipping lint/build before reporting done
- Pushing to remote before "ship it"
- Closing an issue before "ship it"
- Starting a second issue in the same session without user authorization
- Editing HANDOFF.md before "ship it"
- Amending commits that have already been merged
- Using `--no-verify` to skip hooks
