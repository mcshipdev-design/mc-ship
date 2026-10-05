# MC Ship policy rules

Each rule returns findings with a severity. `fail` blocks `mc deploy`. `warn` is shown but does not block (unless `--fail-on warn`).

| Rule id | Severity | What it catches | Typical fix |
| --- | --- | --- | --- |
| `hardcoded-bu-values` | fail | `ContentBlockById(...)`, DEs referenced by generated GUID keys, the source BU MID in content | Use `ContentBlockByKey("key")` and DE names or stable keys |
| `broken-de-reference` | fail | `Lookup`, `LookupRows`, `LookupOrderedRows`, `ClaimRow`, `InsertDE`/`UpsertDE`... pointing at a DE or field that will not exist in the target | Ship the DE or field in the same release, or fix the name |
| `email-footer-compliance` | fail | An email (including the content blocks it includes by key) with no unsubscribe link or no physical address | Add `%%unsub_center_url%%` and `%%Member_Busname%%, %%Member_Addr%%, %%Member_City%%` |
| `pii-and-sendability` | fail / warn | Sendable DE whose send field is missing (fail); email or phone stored as Text, sensitive fields (birth date, SSN, passport, tax ID) with no retention policy (warn) | Use EmailAddress / Phone types; set row-based retention |
| `missing-content-block` | fail / warn | `ContentBlockByKey` to a block that is not in the target or the release (fail); `ContentBlockByName` with no block of that name (warn) | Add the block to the release; prefer keys over names |
| `destructive-de-change` | fail / warn | Field removed, type changed, length reduced or primary key changed on an existing DE: fail when it holds rows, warn when empty | Add a new field instead, or rebuild the DE by hand with a backup |

## How checks see the release

- Source = the files under `mc/<source BU>/` (what you will deploy).
- Target = the last pull of the target BU. `mc deploy` always refreshes it first.
- Only added or changed assets are checked. The "after" view merges the release into the target, so a DE or block shipped in the same release counts as present.

## Running a subset

```
agentia mc check DEV PROD --rule broken-de-reference --rule email-footer-compliance --json
```
