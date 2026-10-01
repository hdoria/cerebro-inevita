# Issue tracker: GitHub (repo privado hugo-os-lab)

Issues e specs deste fork vivem nas GitHub Issues do repo **privado** `hdoria/hugo-os-lab`. Use o `gh` CLI para tudo, sempre com `-R hdoria/hugo-os-lab`.

> Este fork (`hdoria/cerebro-inevita`) é **público** e está com Issues desligadas. Spec ou ticket que cite o vault (notas, pessoas, empresas, contagens do cérebro) nunca vai para o fork. Não infira o repo pelo `git remote`: ele aponta para o fork público.

## Conventions

- **Create an issue**: `gh issue create -R hdoria/hugo-os-lab --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view -R hdoria/hugo-os-lab <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list -R hdoria/hugo-os-lab --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment -R hdoria/hugo-os-lab <number> --body "..."`
- **Apply / remove labels**: `gh issue edit -R hdoria/hugo-os-lab <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close -R hdoria/hugo-os-lab <number> --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `hdoria/hugo-os-lab`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view -R hdoria/hugo-os-lab <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets, all in `hdoria/hugo-os-lab`.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create -R hdoria/hugo-os-lab --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's native issue dependencies: `gh api --method POST repos/hdoria/hugo-os-lab/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric database id (`gh api repos/hdoria/hugo-os-lab/issues/<n> --jq .id`). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children, drop any with an open blocker or an assignee; first in map order wins.
- **Claim**: `gh issue edit -R hdoria/hugo-os-lab <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment -R hdoria/hugo-os-lab <n> --body "<answer>"`, then `gh issue close -R hdoria/hugo-os-lab <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
