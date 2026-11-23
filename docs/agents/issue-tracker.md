# Issue tracker: GitHub

Track requests and specs in GitHub Issues. Use `gh` from the repository root.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`
- **Read an issue**: `gh issue view <number> --comments`
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments`
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

When a skill asks to publish a spec, create an issue rather than a pull request.
When it asks to fetch a ticket, read the issue and its comments.

## After merging a pull request

1. Run `gh pr view <pr> --json state,baseRefName,body` and confirm the PR is `MERGED` into the intended branch.
2. Close only issues the PR explicitly resolves (for example, `Fixes #123`, `Closes #123`, or `Resolves #123`). Leave issues mentioned only as `Refs #123` open.
3. For each resolved issue that is still open, run `gh issue close <issue> --reason completed --comment "Fixed in #<pr>, merged into <branch>."`. Verify that the issue is closed.

Apply this checklist on release branches without waiting for `main`. GitHub's automatic issue closure only works on merges into the default branch.

## Wayfinding operations

Before creating a map or child issue, run `gh label list --search 'wayfinder:'`.
If the required label is missing, stop and ask a maintainer before creating the issue.

- **Map**: Create a GitHub issue with `gh issue create --label wayfinder:map`.
- **Child ticket**: Create an issue with the appropriate `wayfinder:<type>` label
  (`research`, `prototype`, `grilling`, or `task`). Link it with
  `gh api --method POST 'repos/{owner}/{repo}/issues/<map>/sub_issues' -F sub_issue_id=<child-db-id>`.
  Get the numeric database ID with `gh api 'repos/{owner}/{repo}/issues/<number>' --jq .id`.
  Use that ID in the request body, not the issue number.
- **Blocking**: Add a native dependency with
  `gh api --method POST 'repos/{owner}/{repo}/issues/<child>/dependencies/blocked_by' -F issue_id=<blocker-db-id>`.
- **Frontier**: List children with `gh api --paginate 'repos/{owner}/{repo}/issues/<map>/sub_issues'`.
  Consult each child's `issue_dependencies_summary.blocked_by` (open blockers).
  Pick the first open, unassigned child in map order with no open blockers.
  Claim it before working with `gh issue edit <child> --add-assignee @me`.
- **Resolution**: Post the answer with `gh issue comment <child>`, then close the child with
  `gh issue close <child>`. Read the latest map body and append a one-line summary and link
  to **Decisions so far**.
