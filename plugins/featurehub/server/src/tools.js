import { z } from 'zod';
import { FeatureHubError } from './client.js';

const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

const VALUE_FIELD = {
  BOOLEAN: 'valueBoolean',
  NUMBER: 'valueNumber',
  STRING: 'valueString',
  JSON: 'valueJson',
};

const uuid = (what) => z.string().describe(`${what} id (UUID)`);

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(err) {
  const message = err instanceof FeatureHubError ? err.message : `Unexpected error: ${err.message}`;
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Wraps a handler so FeatureHub errors come back to the model as tool errors it can act on.
const safe = (fn) => async (args) => {
  try {
    return ok(await fn(args));
  } catch (err) {
    return fail(err);
  }
};

function readValue(fv, valueType) {
  if (!fv) return null;
  if (fv.value !== undefined && fv.value !== null) return fv.value;
  return fv[VALUE_FIELD[valueType]] ?? null;
}

// Converts the caller's value to what FeatureHub expects for the feature's type.
function coerceValue(value, valueType) {
  if (value === null || value === undefined) {
    if (valueType === 'BOOLEAN') throw new FeatureHubError('Boolean flags must be true or false, not null.');
    return null;
  }
  switch (valueType) {
    case 'BOOLEAN':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      break;
    case 'NUMBER': {
      const n = typeof value === 'number' ? value : Number(value);
      if (typeof value !== 'boolean' && value !== '' && Number.isFinite(n)) return n;
      break;
    }
    case 'STRING':
      if (typeof value === 'string') return value;
      break;
    case 'JSON': {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      try {
        JSON.parse(text);
        return text;
      } catch {
        throw new FeatureHubError('JSON features need valid JSON.');
      }
    }
  }
  throw new FeatureHubError(`Value ${JSON.stringify(value)} is not valid for a ${valueType} feature.`);
}

const summarizeEnvironment = (e) => ({ id: e.id, name: e.name, production: !!e.production });

function summarizeValue(fv, valueType) {
  return {
    value: readValue(fv, valueType),
    locked: !!fv?.locked,
    retired: !!fv?.retired,
    hasRolloutStrategies: (fv?.rolloutStrategies?.length ?? 0) + (fv?.rolloutStrategyInstances?.length ?? 0) > 0,
    version: fv?.version ?? null,
    whenUpdated: fv?.whenUpdated ?? null,
    whoUpdated: fv?.whoUpdated?.name ?? fv?.whoUpdated?.email ?? null,
  };
}

export function registerTools(server, client, { readOnly }) {
  async function getFeature(applicationId, key) {
    return client.get(`/application/${applicationId}/features/${encodeURIComponent(key)}`);
  }

  // Refuses writes to environments FeatureHub marks as production unless explicitly confirmed.
  async function guardProduction(environmentId, confirmProduction) {
    const env = await client.get(`/environment/${environmentId}`);
    if (env.production && !confirmProduction) {
      throw new FeatureHubError(
        `"${env.name}" is a production environment. Confirm with the user, then call again with confirmProduction: true.`,
      );
    }
    return env;
  }

  async function getCurrentValue(environmentId, key) {
    try {
      return await client.get(`/features/${environmentId}/feature/${encodeURIComponent(key)}`);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async function saveValue(environmentId, key, current, changes) {
    const path = `/features/${environmentId}/feature/${encodeURIComponent(key)}`;
    if (current) return client.put(path, { ...current, ...changes });
    return client.post(path, { key, environmentId, locked: false, version: 0, ...changes });
  }

  server.registerTool(
    'list_portfolios',
    {
      title: 'List portfolios',
      description: 'List FeatureHub portfolios visible to the admin service account, optionally with their applications.',
      inputSchema: z.object({
        filter: z.string().optional().describe('Partial name match'),
        includeApplications: z.boolean().optional(),
      }),
      annotations: READ,
    },
    safe(async ({ filter, includeApplications }) => {
      const portfolios = await client.get('/portfolio', { filter, includeApplications });
      return portfolios.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        ...(includeApplications && { applications: (p.applications ?? []).map((a) => ({ id: a.id, name: a.name })) }),
      }));
    }),
  );

  server.registerTool(
    'list_applications',
    {
      title: 'List applications',
      description: 'List the applications in a portfolio, with their environments.',
      inputSchema: z.object({
        portfolioId: uuid('Portfolio'),
        filter: z.string().optional().describe('Partial name match'),
      }),
      annotations: READ,
    },
    safe(async ({ portfolioId, filter }) => {
      const apps = await client.get(`/portfolio/${portfolioId}/application`, { filter, includeEnvironments: true });
      return apps.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description ?? null,
        environments: (a.environments ?? []).map(summarizeEnvironment),
      }));
    }),
  );

  server.registerTool(
    'list_environments',
    {
      title: 'List environments',
      description: 'List the environments of an application, including whether each is marked as production.',
      inputSchema: z.object({ applicationId: uuid('Application') }),
      annotations: READ,
    },
    safe(async ({ applicationId }) => {
      const envs = await client.get(`/application/${applicationId}/environment`);
      return envs.map(summarizeEnvironment);
    }),
  );

  server.registerTool(
    'list_features',
    {
      title: 'List features',
      description: 'List the features (flags and config values) defined in an application.',
      inputSchema: z.object({
        applicationId: uuid('Application'),
        filter: z.string().optional().describe('Case-insensitive match on key or name'),
      }),
      annotations: READ,
    },
    safe(async ({ applicationId, filter }) => {
      const features = await client.get(`/application/${applicationId}/features`);
      const needle = filter?.toLowerCase();
      return features
        .filter((f) => !f.whenArchived)
        .filter((f) => !needle || f.key.toLowerCase().includes(needle) || f.name?.toLowerCase().includes(needle))
        .map((f) => ({ key: f.key, name: f.name, valueType: f.valueType, description: f.description ?? null }));
    }),
  );

  server.registerTool(
    'get_feature_values',
    {
      title: 'Get feature values',
      description: "Show one feature's value, lock and rollout state in every environment of its application.",
      inputSchema: z.object({
        applicationId: uuid('Application'),
        key: z.string().describe('Feature key'),
      }),
      annotations: READ,
    },
    safe(async ({ applicationId, key }) => {
      const [feature, perEnv] = await Promise.all([
        getFeature(applicationId, key),
        client.get(`/application/${applicationId}/feature-environments/${encodeURIComponent(key)}`),
      ]);
      return {
        key: feature.key,
        name: feature.name,
        valueType: feature.valueType,
        environments: perEnv.map((fe) => ({
          ...summarizeEnvironment(fe.environment),
          ...summarizeValue(fe.featureValue, feature.valueType),
          yourRoles: fe.roles ?? [],
        })),
      };
    }),
  );

  if (readOnly) return;

  server.registerTool(
    'set_feature_value',
    {
      title: 'Set feature value',
      description:
        'Set the default value of a feature in one environment. Existing rollout strategies are kept. ' +
        'Fails if the feature is locked there (unlock it first with set_feature_lock). ' +
        'Production environments need confirmProduction: true, which you must only pass after the user explicitly agreed.',
      inputSchema: z.object({
        applicationId: uuid('Application'),
        environmentId: uuid('Environment'),
        key: z.string().describe('Feature key'),
        value: z
          .union([z.boolean(), z.number(), z.string(), z.null(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
          .describe('New value: boolean for flags, number, string, or JSON object/array/string for JSON features. null clears non-flag values.'),
        confirmProduction: z.boolean().optional(),
      }),
      annotations: WRITE,
    },
    safe(async ({ applicationId, environmentId, key, value, confirmProduction }) => {
      const [feature, env] = await Promise.all([
        getFeature(applicationId, key),
        guardProduction(environmentId, confirmProduction),
      ]);
      const current = await getCurrentValue(environmentId, key);
      if (current?.locked) {
        throw new FeatureHubError(`"${key}" is locked in "${env.name}". Unlock it with set_feature_lock first.`);
      }
      const coerced = coerceValue(value, feature.valueType);
      // Send both the preferred `value` and the legacy typed field so older FeatureHub servers accept it too.
      const saved = await saveValue(environmentId, key, current, { value: coerced, [VALUE_FIELD[feature.valueType]]: coerced });
      return { environment: summarizeEnvironment(env), key, ...summarizeValue(saved, feature.valueType) };
    }),
  );

  server.registerTool(
    'set_feature_lock',
    {
      title: 'Lock or unlock feature',
      description:
        'Lock or unlock a feature in one environment. A locked feature cannot have its value changed. ' +
        'Production environments need confirmProduction: true, which you must only pass after the user explicitly agreed.',
      inputSchema: z.object({
        environmentId: uuid('Environment'),
        key: z.string().describe('Feature key'),
        locked: z.boolean(),
        confirmProduction: z.boolean().optional(),
      }),
      annotations: WRITE,
    },
    safe(async ({ environmentId, key, locked, confirmProduction }) => {
      const env = await guardProduction(environmentId, confirmProduction);
      const current = await getCurrentValue(environmentId, key);
      const saved = await saveValue(environmentId, key, current, { locked });
      return { environment: summarizeEnvironment(env), key, locked: !!saved?.locked, version: saved?.version ?? null };
    }),
  );

  server.registerTool(
    'create_feature',
    {
      title: 'Create feature',
      description: 'Create a new feature in an application. It starts locked/unset in every environment until values are set.',
      inputSchema: z.object({
        applicationId: uuid('Application'),
        key: z.string().regex(/^[A-Za-z0-9_\-.]+$/).describe('Key used in code; unique within the application'),
        name: z.string().describe('Human-readable name'),
        valueType: z.enum(['BOOLEAN', 'STRING', 'NUMBER', 'JSON']),
        description: z.string().max(300).optional(),
      }),
      annotations: WRITE,
    },
    safe(async ({ applicationId, key, name, valueType, description }) => {
      const all = await client.post(`/application/${applicationId}/features`, { key, name, valueType, description });
      const created = all.find((f) => f.key === key);
      return { key: created?.key ?? key, name: created?.name ?? name, valueType: created?.valueType ?? valueType, id: created?.id ?? null };
    }),
  );
}
