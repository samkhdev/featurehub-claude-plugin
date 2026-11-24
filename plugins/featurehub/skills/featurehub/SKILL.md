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

1. Say exactly what will change: feature key, environment name, old value → new value.
2. `set_feature_value` changes the **default** value only. Existing rollout strategies stay, so if `hasRolloutStrategies` is true, tell the user that some users may still get a different value.
3. If the feature is locked in that environment, ask before unlocking it with `set_feature_lock`. Don't unlock and change it without asking.
4. **Production:** environments with `production: true` reject writes unless you pass `confirmProduction: true`. Pass it **only** after the user has explicitly confirmed that production change in this conversation. Never pass it on your own initiative, and never reuse a confirmation given for a different change.
5. After a write, report the new value and version from the tool result.

## Creating features

- Keys are used in code and are hard to rename. Suggest an `UPPER_SNAKE_CASE` key (unless the application's existing keys use another style) and confirm it with the user.
- A new feature has no value anywhere yet, so offer to set values per environment afterwards.

## Errors

- HTTP 401: the admin token is wrong or was reset. The user should run `/plugin configure featurehub`.
- HTTP 403: the user's admin service account isn't in a group with the needed permission. Tell them which portfolio or application is affected. Don't retry.
- HTTP 409: someone else changed the value first. Re-read the state with `get_feature_values` and confirm again before retrying.
