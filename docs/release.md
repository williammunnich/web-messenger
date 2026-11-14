# Release checklist

How a change in this repo is tested and how it reaches a running messenger. Deploying is
described step by step in [deploy.md](deploy.md); this page only says what is automatic and what is not.

## What is automatic, and what is not

```
git push (GitHub)  ─▶  .github/workflows/test.yml   npm ci ─ npm test ─ npm run smoke ─ bash tools/check-public.sh
                       (every push and pull request; it tests only, it deploys nothing)

your machine or AWS CloudShell  ─▶  bash aws/deploy.sh deploy   runs the tests again, then updates the stack
                                    (by hand, with your own AWS sign-in and your deploy.env)
```

- **GitHub Actions never touches AWS.** The workflow has no AWS credentials, no secrets and no variables. A green
  run means the code is sound; it does not mean anything was deployed.
- **Deploying is by hand**, on purpose: each person who uses this project deploys to their own AWS account with
  their own `deploy.env`, which is not in git. There is no deploy job to switch on.

## Gates

| Gate | Where it runs | What it stops |
|---|---|---|
| `npm test` | GitHub Actions, and again inside `aws/deploy.sh deploy` | broken chat logic, sign-in, storage, visitor data rules |
| `npm run smoke` | GitHub Actions | the end-to-end path on the local bench (visitor writes, owner replies) |
| `bash tools/check-public.sh` | GitHub Actions; run it before every push | key and token shapes, files that must never be committed (`deploy.env`, `.p8`, `.pem`), your own private strings from `.private-patterns` |
| the stack-name check in `aws/deploy.sh` | at deploy | updating a stack of the same name that this repo did not create |

## Every release

1. `npm test && npm run smoke && bash tools/check-public.sh`
2. Commit and push. Watch the run: `gh run watch`. If it fails: `gh run view --log-failed`.
3. To put the change on a running messenger: `bash aws/deploy.sh deploy` (see [deploy.md](deploy.md), "Updating and
   removing"). The widget file is cached by browsers for 5 minutes.
4. Go through the checklist at the end of [deploy.md](deploy.md) ("After deploying: check what local testing can't").

## Sites that embed the widget

A site loads the widget with one script tag from the messenger's own address ([embed.md](embed.md)), so a messenger
deploy reaches every embedding site without rebuilding those sites. Two things on the site's side must match the
messenger: the site's address in `ALLOWED_ORIGINS` (`deploy.env`), and, if the site sends a Content-Security-Policy,
the messenger's hosts in it. A site that keeps its own copy of the widget files is updated by that site's release,
not by this one.

## Rollback

There is no automatic rollback and no deploy history kept by this repo. To go back: check out the last good commit
and run `bash aws/deploy.sh deploy` again. CloudFormation itself rolls back a stack update that fails part-way.
The conversation table is never replaced by a deploy.

## Not built

- No deploy from GitHub Actions (no OIDC role, no deploy job). If that is ever wanted, it needs a role limited to
  this stack and a decision about where `deploy.env`'s values would live.
- No staging stack by default; a second copy under another `PREFIX` in `deploy.env` serves as one.
