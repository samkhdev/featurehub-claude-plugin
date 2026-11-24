// Runs the bundled server (dist/index.js) over stdio against a fake FeatureHub Admin API,
// acting as an MCP client that answers approval forms (elicitation) the way a user would.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const TOKEN = 'test-token';
const EMAIL = 'dev@example.com';
const PASSWORD = 'secret';
const APP = '11111111-1111-1111-1111-111111111111';
const DEV = '22222222-2222-2222-2222-222222222222';
const PROD = '33333333-3333-3333-3333-333333333333';

const envs = {
  [DEV]: { id: DEV, name: 'dev', production: false },
  [PROD]: { id: PROD, name: 'production', production: true },
};
let values;
let requests;
let validSessions;
let loginStatus;
let sessionCounter = 0;

const fake = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const { pathname } = new URL(req.url, 'http://x');
  requests.push({ method: req.method, path: pathname, body: body && JSON.parse(body), auth: req.headers.authorization });
  const send = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(data === undefined ? '' : JSON.stringify(data));
  };

  if (pathname === '/mr-api/login' && req.method === 'POST') {
    if (loginStatus !== 200) return send(loginStatus);
    const { email, password } = JSON.parse(body);
    if (email !== EMAIL || password !== PASSWORD) return send(401);
    const accessToken = `session-${++sessionCounter}`;
    validSessions.add(accessToken);
    return send(200, { accessToken, refreshToken: 'r', person: { email } });
  }

  const bearer = req.headers.authorization?.replace(/^Bearer /, '');
  if (bearer !== TOKEN && !validSessions.has(bearer)) return send(401);

  let m;
  if (pathname === '/mr-api/portfolio') return send(200, [{ id: 'p1', name: 'Core', applications: [{ id: APP, name: 'web' }] }]);
  if (pathname === `/mr-api/application/${APP}`) return send(200, { id: APP, name: 'web' });
  if (pathname === `/mr-api/application/${APP}/features/DARK_MODE`) return send(200, { key: 'DARK_MODE', name: 'Dark mode', valueType: 'BOOLEAN' });
  if (pathname === `/mr-api/application/${APP}/features`) {
    if (req.method === 'POST') return send(200, [{ id: 'f2', ...JSON.parse(body) }]);
    return send(200, [{ key: 'DARK_MODE', name: 'Dark mode', valueType: 'BOOLEAN' }, { key: 'OLD', name: 'Old', valueType: 'STRING', whenArchived: '2025-01-01' }]);
  }
  if (pathname === `/mr-api/application/${APP}/feature-environments/DARK_MODE`) {
    return send(200, Object.values(envs).map((e) => ({ environment: e, featureValue: values[e.id], roles: ['READ'] })));
  }
  if ((m = pathname.match(/^\/mr-api\/environment\/(.+)$/))) return envs[m[1]] ? send(200, envs[m[1]]) : send(404);
  if ((m = pathname.match(/^\/mr-api\/features\/(.+)\/feature\/DARK_MODE$/))) {
    const eid = m[1];
    if (req.method === 'GET') return values[eid] ? send(200, values[eid]) : send(404);
    const next = JSON.parse(body);
    values[eid] = { ...next, version: (next.version ?? 0) + 1 };
    return send(200, values[eid]);
  }
  send(404);
});

const writes = () => requests.filter((q) => q.method !== 'GET' && q.path !== '/mr-api/login');

// --- minimal MCP client over stdio ---

let child;
let nextId = 1;
let pending;
let forms; // approval forms the server showed to the "user"
let answerForm; // how the "user" answers them

function send(msg) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

function rpc(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function call(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  const text = result.content[0].text;
  return { isError: !!result.isError, text, data: result.isError ? null : JSON.parse(text) };
}

async function start(env, { canShowForms = true } = {}) {
  child?.kill();
  pending = new Map();
  child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, FEATUREHUB_URL: `http://127.0.0.1:${fake.address().port}/`, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.method === 'elicitation/create') {
      forms.push(msg.params);
      return send({ id: msg.id, result: answerForm(msg.params) });
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  });
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: canShowForms ? { elicitation: { form: {} } } : {},
    clientInfo: { name: 'smoke', version: '0' },
  });
  send({ method: 'notifications/initialized' });
}

const approve = () => ({ action: 'accept', content: { confirm: true } });
const decline = () => ({ action: 'decline' });

before(() => new Promise((r) => fake.listen(0, '127.0.0.1', r)));
after(() => {
  child?.kill();
  fake.close();
});
beforeEach(() => {
  values = {};
  requests = [];
  validSessions = new Set();
  loginStatus = 200;
  forms = [];
  answerForm = approve;
});

const READ_TOOLS = ['get_feature_values', 'list_applications', 'list_environments', 'list_features', 'list_portfolios'];
const WRITE_TOOLS = ['create_feature', 'set_feature_lock', 'set_feature_value'];
const toolNames = async () => (await rpc('tools/list', {})).tools.map((t) => t.name).sort();

// --- Layer 1: read-only unless write access is turned on ---

test('is read-only by default', async () => {
  await start({ FEATUREHUB_ADMIN_TOKEN: TOKEN });
  assert.deepEqual(await toolNames(), READ_TOOLS);
});

test('treats unset plugin options passed through as ${user_config.x} as unset', async () => {
  await start({ FEATUREHUB_ADMIN_TOKEN: TOKEN, FEATUREHUB_WRITE_ACCESS: '${user_config.write_access}' });
  assert.deepEqual(await toolNames(), READ_TOOLS);
});

test('exposes write tools when write access is "ask"', async () => {
  await start({ FEATUREHUB_ADMIN_TOKEN: TOKEN, FEATUREHUB_WRITE_ACCESS: 'ask' });
  assert.deepEqual(await toolNames(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
});

test('reads work and hide archived features', async () => {
  await start({ FEATUREHUB_ADMIN_TOKEN: TOKEN });
  const portfolios = await call('list_portfolios', { includeApplications: true });
  assert.equal(portfolios.data[0].applications[0].id, APP);
  const features = await call('list_features', { applicationId: APP });
  assert.deepEqual(features.data.map((f) => f.key), ['DARK_MODE']);
  values = { [DEV]: { key: 'DARK_MODE', locked: false, valueBoolean: true, version: 2 } };
  const r = await call('get_feature_values', { applicationId: APP, key: 'DARK_MODE' });
  const byName = Object.fromEntries(r.data.environments.map((e) => [e.name, e]));
  assert.equal(byName.dev.value, true);
  assert.equal(byName.production.value, null);
});

// --- Layer 2: every write needs the user's approval in a form ---

test('writes after the user approves, showing them the exact change', async () => {
  await start({ FEATUREHUB_ADMIN_TOKEN: TOKEN, FEATUREHUB_WRITE_ACCESS: 'ask' });
  values = { [PROD]: { key: 'DARK_MODE', locked: false, valueBoolean: false, version: 3 } };
  const r = await call('set_feature_value', { applicationId: APP, environmentId: PROD, key: 'DARK_MODE', value: true });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.value, true);
  assert.equal(forms.length, 1);
  assert.match(forms[0].message, /DARK_MODE/);
  assert.match(forms[0].message, /production\s+⚠ PRODUCTION/);
  assert.match(forms[0].message, /false → true/);
  const [put] = writes();
  assert.equal(put.method, 'PUT');
  assert.equal(put.body.valueBoolean, true);
  assert.equal(put.body.version, 3, 'PUT sends the version it read');
});

test('creates a value that was never set, after approval', async () => {
  await start({ FEATUREHUB_ADMIN_TOKEN: TOKEN, FEATUREHUB_WRITE_ACCESS: 'ask' });
  const r = await call('set_feature_value', { applicationId: APP, environmentId: DEV, key: 'DARK_MODE', value: 'true' });
  assert.equal(r.data.value, true);
  assert.match(forms[0].message, /\(not set\) → true/);
  assert.equal(writes()[0].method, 'POST');
});

test('writes nothing when the user declines', async () => {
  await start({ FEATUREHUB_ADMIN_TOKEN: TOKEN, FEATUREHUB_WRITE_ACCESS: 'ask' });
  answerForm = decline;
  values = { [DEV]: { key: 'DARK_MODE', locked: false, valueBoolean: false, version: 1 } };
  const r = await call('set_feature_value', { applicationId: APP, environmentId: DEV, key: 'DARK_MODE', value: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /did not approve/);
  assert.equal(forms.length, 1, 'asks once, does not re-ask after a decline');
  assert.deepEqual(writes(), []);
});

test('writes nothing when the user accepts but unticks confirm, or cancels', async () => {
  await start({ FEATUREHUB_ADMIN_TOKEN: TOKEN, FEATUREHUB_WRITE_ACCESS: 'ask' });
  for (const answer of [{ action: 'accept', content: { confirm: false } }, { action: 'cancel' }]) {
    answerForm = () => answer;
    const r = await call('set_feature_lock', { environmentId: DEV, key: 'DARK_MODE', locked: true });
    assert.equal(r.isError, true, JSON.stringify(answer));
  }
  assert.deepEqual(writes(), []);
});

test('writes nothing when the client cannot show approval forms', async () => {
  await start({ FEATUREHUB_ADMIN_TOKEN: TOKEN, FEATUREHUB_WRITE_ACCESS: 'ask' }, { canShowForms: false });
  const r = await call('create_feature', { applicationId: APP, key: 'NEW_FLAG', name: 'New flag', valueType: 'BOOLEAN' });
  assert.equal(r.isError, true, r.text);
  assert.deepEqual(writes(), []);
});

test('lock and create also need approval', async () => {
  await start({ FEATUREHUB_ADMIN_TOKEN: TOKEN, FEATUREHUB_WRITE_ACCESS: 'ask' });
  values = { [DEV]: { key: 'DARK_MODE', locked: false, valueBoolean: false, version: 1 } };
  const lock = await call('set_feature_lock', { environmentId: DEV, key: 'DARK_MODE', locked: true });
  assert.equal(lock.data.locked, true);
  const created = await call('create_feature', { applicationId: APP, key: 'NEW_FLAG', name: 'New flag', valueType: 'BOOLEAN' });
  assert.equal(created.data.key, 'NEW_FLAG');
  assert.equal(forms.length, 2);
  assert.match(forms[1].message, /Application: web/);
});

test('refuses to change a locked value without asking', async () => {
  await start({ FEATUREHUB_ADMIN_TOKEN: TOKEN, FEATUREHUB_WRITE_ACCESS: 'ask' });
  values = { [DEV]: { key: 'DARK_MODE', locked: true, valueBoolean: false, version: 1 } };
  const r = await call('set_feature_value', { applicationId: APP, environmentId: DEV, key: 'DARK_MODE', value: true });
  assert.match(r.text, /locked/);
  assert.equal(forms.length, 0);
});

test('rejects values of the wrong type without asking', async () => {
  await start({ FEATUREHUB_ADMIN_TOKEN: TOKEN, FEATUREHUB_WRITE_ACCESS: 'ask' });
  const r = await call('set_feature_value', { applicationId: APP, environmentId: DEV, key: 'DARK_MODE', value: 'maybe' });
  assert.match(r.text, /not valid for a BOOLEAN/);
  assert.equal(forms.length, 0);
});

// --- Authentication ---

test('logs in with email and password, and again when the session expires', async () => {
  await start({ FEATUREHUB_EMAIL: EMAIL, FEATUREHUB_PASSWORD: PASSWORD });
  assert.equal((await call('list_portfolios', {})).isError, false);
  validSessions.clear(); // session expires
  const r = await call('list_portfolios', {});
  assert.equal(r.isError, false, r.text);
  assert.equal(requests.filter((q) => q.path === '/mr-api/login').length, 2);
});

test('explains a wrong password and SSO-only instances', async () => {
  await start({ FEATUREHUB_EMAIL: EMAIL, FEATUREHUB_PASSWORD: 'nope' });
  assert.match((await call('list_portfolios', {})).text, /Wrong email or password/);
  loginStatus = 403;
  await start({ FEATUREHUB_EMAIL: EMAIL, FEATUREHUB_PASSWORD: PASSWORD });
  assert.match((await call('list_portfolios', {})).text, /SSO/);
});

test('explains a rejected token and missing configuration', async () => {
  await start({ FEATUREHUB_ADMIN_TOKEN: 'wrong' });
  assert.match((await call('list_portfolios', {})).text, /HTTP 401/);
  await start({ FEATUREHUB_ADMIN_TOKEN: '${user_config.admin_token}' });
  assert.match((await call('list_portfolios', {})).text, /not configured/);
});
