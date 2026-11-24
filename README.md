# FeatureHub plugin for Claude Code

Lets Claude Code read and change [FeatureHub](https://github.com/featurehub-io/featurehub) features through the FeatureHub Admin (MR) API. It runs a local MCP server over stdio on your machine and doesn't need any hosting.

## Tools

| Tool | What it does |
|---|---|
| `list_portfolios`, `list_applications`, `list_environments`, `list_features` | Find the portfolio, application, environment and feature ids |
| `get_feature_values` | Show one feature's value, lock and rollout state in each environment |
| `set_feature_value` | Set a feature's default value in one environment. Keeps any rollout strategies. |
| `set_feature_lock` | Lock or unlock a feature in one environment |
| `create_feature` | Create a feature (BOOLEAN / STRING / NUMBER / JSON) |

## Authentication

Every user should have **their own admin service account**:

1. A FeatureHub super admin creates the service account on the **Admin Service Accounts** page, e.g. `claude-<your-name>`. Copy the token right away, because FeatureHub shows it only once. It can be reset later.
2. Add that service account to the groups that hold the permissions you need. To start with read-only access, use groups that only have read permission.
3. Claude Code asks for the URL and token when you install or enable the plugin (`/plugin configure featurehub` changes them later). The token is stored in your OS keychain, not in any file.

Why this setup:

- Logging in with a password won't work for SSO-only instances, and browser session tokens expire.
- Sharing one token across the team would make every change in FeatureHub's history look like it came from the same account.
- With a personal service account, FeatureHub's own permissions limit what Claude can do, the audit log shows whose session made each change, and you can revoke one person's access without affecting anyone else.

## Safety

- Writes to environments FeatureHub marks as **production** are refused unless the call includes `confirmProduction: true`. The bundled skill tells Claude to set it only after you've explicitly confirmed.
- Claude Code asks for permission before every MCP tool call unless you've allowed that tool. A sensible setup is to allow only the read tools:
  ```json
  { "permissions": { "allow": [
    "mcp__plugin_featurehub_featurehub__list_*",
    "mcp__plugin_featurehub_featurehub__get_feature_values"
  ] } }
  ```
- Set `FEATUREHUB_READ_ONLY=true` in the environment Claude Code runs in to hide the write tools completely.

## Install

```
/plugin marketplace add <git-url-or-local-path-of-this-repo>
/plugin install featurehub@featurehub-tools
```

To try it locally without installing: `claude --plugin-dir ./plugins/featurehub`.

The server needs Node 20 or newer. Using it outside Claude Code (e.g. Claude Desktop or Cursor): run `node plugins/featurehub/server/dist/index.js` with `FEATUREHUB_URL` and `FEATUREHUB_ADMIN_TOKEN` set.

## Development

```
cd plugins/featurehub/server
npm install
npm test        # builds dist/index.js and runs the smoke tests against a fake FeatureHub
```

`dist/index.js` is a single bundled file and is **committed on purpose**, because installed plugins run it directly without running `npm install`. Run `npm run build` and commit the result whenever you change `src/`.
