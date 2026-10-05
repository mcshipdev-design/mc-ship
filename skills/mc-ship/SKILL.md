---
name: mc-ship
description: Use this skill when moving Salesforce Marketing Cloud (SFMC) work between Business Units or orgs with the MC Ship Agentia plugin or MCP tools: pulling Data Extensions and Content Builder emails, blocks and templates into Git, diffing DEV vs PROD, running release policy checks, explaining release risk, and deploying with an audit trail linked to a Copado user story. Use it whenever the user asks to ship, promote, release, compare or check Marketing Cloud assets.
---

# MC Ship: Marketing Cloud releases with Agentia

Use this skill to ship Marketing Cloud changes safely, in a fixed order, without guessing BU names or skipping checks.

Prefer the MC Ship MCP tools (`mc_status`, `mc_pull`, `mc_diff`, `mc_check`, `mc_explain`, `mc_deploy`) when they are available. Otherwise use the CLI and always add `--json` when you will read the result.

## Start Here

1. Run `mc_status` (or read `.mcship/config.json`) to learn which BUs are connected. Never invent BU names.
2. If a BU the user names is missing, stop and ask the user to run `agentia mc connect <BU>` themselves. Never ask for, print or store client secrets.
3. Work out the source BU (where the change was built, usually DEV) and the target BU (where it should go, usually PROD). Ask if unclear.

## The Release Flow (always in this order)

1. **Pull both BUs.** `mc_pull {bus:["DEV","PROD"]}` / `agentia mc pull --bu DEV --bu PROD --json`.
   The source BU is now in Git under `mc/<BU>/`. Edits to those files are what gets deployed.
2. **Diff.** `mc_diff {from, to}` / `agentia mc diff DEV PROD --json`. Tell the user, in one short list, what will be added and changed.
3. **Check.** `mc_check {from, to}` / `agentia mc check DEV PROD --json`.
   - `fail` blocks deploy. For each finding, show the asset, the message and the `fix`.
   - Offer to make the fix in the local files under `mc/<source BU>/`, then run check again.
   - See [references/rules.md](references/rules.md) for what each rule means and how to fix it.
4. **Explain.** `mc_explain {from, to, userStory?}` / `agentia mc explain DEV PROD --json`. Share the summary with the user as written.
5. **Plan.** `mc_deploy {from, to}` (dry run is the default) / `agentia mc deploy DEV PROD --dry-run --json`. Show the plan.
6. **Get approval.** Ask the user to approve deploying the listed assets to the target BU. Wait for a clear yes.
7. **Deploy.** Only after approval: `mc_deploy {from, to, dryRun:false, confirm:true, userStory?}` / `agentia mc deploy DEV PROD --yes --json`.
8. **Commit.** Suggest committing `mc/` (assets and `mc/audit.log.jsonl`) to Git with a message that names the user story.

## Rules

- Never pass `--force` or deploy over a failing check unless the user explicitly says so for this release. Forced deploys are logged.
- MC Ship never deletes assets in the target. If the diff shows `removed`, tell the user it must be done by hand.
- Field type, length and primary key changes on existing DEs are not applied by the API. The check flags them; suggest adding a new field instead.
- Do not edit files under `mc/<target BU>/`. They mirror the live target and are overwritten on every pull and deploy.
- Keep secrets out of output, files and commits.
- If Copado AI is not configured, `mc explain` falls back to a built-in summary. Say which one you used.

## Copado Link

- To tie a release to a user story, pass `userStory` (or `--user-story <ID or name>`). Read the story first with `agentia cicd work get <ID> --json` if the user is unsure which one.
- `--attach` on explain, and any deploy with a user story, writes the note to the story's Technical Specifications.

## Report Back

End with: what was deployed (or why it was blocked), the check status, the audit log entry time, and whether the user story was updated.
