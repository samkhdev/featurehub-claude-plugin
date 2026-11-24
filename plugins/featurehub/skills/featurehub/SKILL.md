---
name: featurehub
description: Use when the user asks about or wants to change FeatureHub feature flags or config values — checking a flag's state per environment, turning a flag on/off, setting a string/number/JSON value, locking/unlocking, or creating a new feature. Uses the featurehub MCP tools.
---

# Working with FeatureHub

FeatureHub is organised as **portfolio → application → environment**. Features belong to an application and have a separate value in each environment.

## Finding things

- Resolve names to ids before acting: `list_portfolios` (with `includeApplications: true`) → `list_applications` → `list_environments` / `list_features`.
- Use `get_feature_values` to see a feature across all environments before changing it, and show the user the current state.

## Changing things

Write tools exist only when the user has turned on write access (`write_access: ask` in `/plugin configure featurehub`). If they're missing, say so and tell the user how to enable them. Don't look for other ways to write.

1. Before calling a write tool, say exactly what will change: feature key, environment name, old value → new value.
2. Each write shows the user an approval form (and usually a Claude Code permission prompt as well). The change happens only if they approve it there. If they decline, nothing is written: report that and don't retry unless they ask again.
3. `set_feature_value` changes the **default** value only. Existing rollout strategies stay, so if `hasRolloutStrategies` is true, tell the user that some users may still get a different value.
4. If the feature is locked in that environment, ask before unlocking it with `set_feature_lock`.
5. Take extra care with environments where `production: true`, and point out that it's production.
6. After a write, report the new value and version from the tool result.

## Creating features

- Keys are used in code and are hard to rename. Suggest an `UPPER_SNAKE_CASE` key (unless the application's existing keys use another style) and confirm it with the user.
- A new feature has no value anywhere yet, so offer to set values per environment afterwards.

## Errors

- HTTP 401, or a login failure: the token or the email/password is wrong. The user should run `/plugin configure featurehub`. If password login is disabled (SSO), they need an admin service account token.
- HTTP 403: the account isn't in a group with the needed permission. Tell them which portfolio or application is affected. Don't retry.
- HTTP 409: someone else changed the value first. Re-read the state with `get_feature_values` and confirm again before retrying.
- "did not declare the required capability": this client can't show approval forms, so writes are impossible here. Tell the user to make the change in an interactive Claude Code session or in the FeatureHub console.
