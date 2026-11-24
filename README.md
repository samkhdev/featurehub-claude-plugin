# FeatureHub plugin for Claude Code

Lets Claude Code read and change [FeatureHub](https://github.com/featurehub-io/featurehub) features through the FeatureHub Admin (MR) API. It runs a local MCP server over stdio on your machine and doesn't need any hosting.

## Tools

| Tool | What it does |
|---|---|
| `list_portfolios`, `list_applications`, `list_environments`, `list_features` | Find the portfolio, application, environment and feature ids |
| `get_feature_values` | Show one feature's value, lock and rollout state in each environment |
| `set_feature_value` * | Set a feature's default value in one environment. Keeps any rollout strategies. |
| `set_feature_lock` * | Lock or unlock a feature in one environment |
| `create_feature` * | Create a feature (BOOLEAN / STRING / NUMBER / JSON) |

\* Write tools. They only appear when write access is turned on (see [Safety](#safety)).

## Authentication

Claude Code asks for these settings when you install or enable the plugin. Change them later with `/plugin configure featurehub`. The token and the password are stored in your OS keychain, not in any file.

- **FeatureHub URL:** the address you open the FeatureHub console at.
- **Then one of these two options:**
  1. **Admin service account token (recommended).** A FeatureHub super admin creates a personal service account for you on the **Admin Service Accounts** page (e.g. `claude-<your-name>`), adds it to groups with the permissions you need, and gives you the token. FeatureHub shows the token only once; it can be reset later.
  2. **Your own email and password.** If you can't get a service account, the plugin logs in as you, with exactly your permissions, and logs in again when the session expires. This doesn't work if your FeatureHub only allows SSO login.

Why not one token for the whole team: every change in FeatureHub's history would look like it came from the same account, and one person's access couldn't be revoked without affecting everyone.

## Safety

Writes are guarded by three independent layers:

1. **Read-only by default.** The `Write access` setting starts at `off`, and in that mode the write tools don't exist, so Claude can't write at all. Set it to `ask` with `/plugin configure featurehub` to allow writes.
2. **You approve every write in a form.** With write access set to `ask`, each write shows you a form from the plugin's server describing the exact change, e.g. `DARK_MODE` in `production ⚠ PRODUCTION`: `false → true`. Claude can't fill in this form. The change is made only if you approve it. Declining, cancelling, or a client that can't show forms (e.g. `claude -p`) means nothing is written.
3. **Claude Code's permission prompt.** The plugin includes a hook that makes Claude Code ask you before any write tool runs, even if you've allowed it in your settings. In modes that never prompt (auto, `dontAsk`, bypass), Claude Code denies the call instead.

Read tools need no approval from the plugin. To stop Claude Code from asking before every lookup, allow them in your settings:
```json
{ "permissions": { "allow": [
  "mcp__plugin_featurehub_featurehub__list_*",
  "mcp__plugin_featurehub_featurehub__get_feature_values"
] } }
```

These limits live in the plugin. FeatureHub itself only sees your account, so your token or password can still do anything you can do in the console.

## Install

```
/plugin marketplace add samkhdev/featurehub-claude-plugin
/plugin install featurehub@featurehub-tools
```

To try it locally without installing: `claude --plugin-dir ./plugins/featurehub`.

The server needs Node 20 or newer, and the `Write access` option needs Claude Code v2.1.271 or later. Using it outside Claude Code (e.g. Claude Desktop or Cursor): run `node plugins/featurehub/server/dist/index.js` with `FEATUREHUB_URL` and either `FEATUREHUB_ADMIN_TOKEN` or `FEATUREHUB_EMAIL` + `FEATUREHUB_PASSWORD` set. Add `FEATUREHUB_WRITE_ACCESS=ask` to enable writes. The client must support MCP elicitation (approval forms) for writes to work.

## Development

```
cd plugins/featurehub/server
npm install
npm test        # builds dist/index.js and runs the smoke tests against a fake FeatureHub
```

`dist/index.js` is a single bundled file and is **committed on purpose**, because installed plugins run it directly without running `npm install`. Run `npm run build` and commit the result whenever you change `src/`.
