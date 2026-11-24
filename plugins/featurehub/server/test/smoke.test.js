// Runs the bundled server (dist/index.js) over stdio against a fake FeatureHub Admin API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const TOKEN = 'test-token';
const APP = '11111111-1111-1111-1111-111111111111';
const DEV = '22222222-2222-2222-2222-222222222222';
const PROD = '33333333-3333-3333-3333-333333333333';

const envs = {
  [DEV]: { id: DEV, name: 'dev', production: false },
  [PROD]: { id: PROD, name: 'production', production: true },
};
let values;
const requests = [];

const fake = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const { pathname } = new URL(req.url, 'http://x');
  requests.push({ method: req.method, path: pathname, body: body && JSON.parse(body) });
  const send = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(data === undefined ? '' : JSON.stringify(data));
  };

  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401);

  let m;
  if (pathname === '/mr-api/portfolio') return send(200, [{ id: 'p1', name: 'Core', applications: [{ id: APP, name: 'web' }] }]);
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

let child;
let nextId = 1;
const pending = new Map();

function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function call(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  const text = result.content[0].text;
  return { isError: !!result.isError, text, data: result.isError ? null : JSON.parse(text) };
}

function start(env) {
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  });
}

async function initialize() {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
}

before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  start({ FEATUREHUB_URL: `http://127.0.0.1:${fake.address().port}/`, FEATUREHUB_ADMIN_TOKEN: TOKEN });
  await initialize();
});

after(() => {
  child.kill();
  fake.close();
});

test('exposes read and write tools', async () => {
  const { tools } = await rpc('tools/list', {});
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'create_feature', 'get_feature_values', 'list_applications', 'list_environments',
    'list_features', 'list_portfolios', 'set_feature_lock', 'set_feature_value',
  ]);
});

test('lists portfolios and hides archived features', async () => {
  const portfolios = await call('list_portfolios', { includeApplications: true });
  assert.equal(portfolios.data[0].applications[0].id, APP);
  const features = await call('list_features', { applicationId: APP });
  assert.deepEqual(features.data.map((f) => f.key), ['DARK_MODE']);
});

test('sets a value in a non-production environment, creating it when unset', async () => {
  values = {};
  const r = await call('set_feature_value', { applicationId: APP, environmentId: DEV, key: 'DARK_MODE', value: 'true' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.value, true);
  const post = requests.findLast((q) => q.method === 'POST');
  assert.equal(post.body.valueBoolean, true);
  assert.equal(post.body.value, true);

  const again = await call('set_feature_value', { applicationId: APP, environmentId: DEV, key: 'DARK_MODE', value: false });
  assert.equal(again.data.value, false);
  assert.equal(requests.findLast((q) => q.method === 'PUT').body.version, 1, 'PUT sends the version it read');
});

test('refuses production writes without confirmProduction', async () => {
  values = { [PROD]: { key: 'DARK_MODE', locked: false, valueBoolean: false, version: 3 } };
  const before = requests.length;
  const r = await call('set_feature_value', { applicationId: APP, environmentId: PROD, key: 'DARK_MODE', value: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /production environment/);
  assert.ok(!requests.slice(before).some((q) => q.method !== 'GET'), 'no write was sent');

  const ok = await call('set_feature_value', { applicationId: APP, environmentId: PROD, key: 'DARK_MODE', value: true, confirmProduction: true });
  assert.equal(ok.data.value, true);
});

test('refuses to change a locked value, and can unlock', async () => {
  values = { [DEV]: { key: 'DARK_MODE', locked: true, valueBoolean: false, version: 1 } };
  const r = await call('set_feature_value', { applicationId: APP, environmentId: DEV, key: 'DARK_MODE', value: true });
  assert.match(r.text, /locked/);
  const unlocked = await call('set_feature_lock', { environmentId: DEV, key: 'DARK_MODE', locked: false });
  assert.equal(unlocked.data.locked, false);
});

test('rejects values of the wrong type', async () => {
  values = { [DEV]: { key: 'DARK_MODE', locked: false, valueBoolean: false, version: 1 } };
  const r = await call('set_feature_value', { applicationId: APP, environmentId: DEV, key: 'DARK_MODE', value: 'maybe' });
  assert.equal(r.isError, true);
  assert.match(r.text, /not valid for a BOOLEAN/);
});

test('shows values per environment', async () => {
  values = { [DEV]: { key: 'DARK_MODE', locked: false, valueBoolean: true, version: 2 } };
  const r = await call('get_feature_values', { applicationId: APP, key: 'DARK_MODE' });
  const byName = Object.fromEntries(r.data.environments.map((e) => [e.name, e]));
  assert.equal(byName.dev.value, true);
  assert.equal(byName.production.value, null);
  assert.equal(byName.production.production, true);
});

test('explains a rejected token', async () => {
  child.kill();
  start({ FEATUREHUB_URL: `http://127.0.0.1:${fake.address().port}`, FEATUREHUB_ADMIN_TOKEN: 'wrong' });
  await initialize();
  const r = await call('list_portfolios', {});
  assert.equal(r.isError, true);
  assert.match(r.text, /HTTP 401.*Admin Service Accounts/);
});

test('read-only mode hides write tools', async () => {
  child.kill();
  start({ FEATUREHUB_URL: 'http://127.0.0.1:1', FEATUREHUB_ADMIN_TOKEN: TOKEN, FEATUREHUB_READ_ONLY: 'true' });
  await initialize();
  const { tools } = await rpc('tools/list', {});
  assert.ok(!tools.some((t) => t.name.startsWith('set_') || t.name === 'create_feature'));
});
