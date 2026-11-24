import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createClient } from './client.js';
import { registerTools } from './tools.js';

// Claude Code may pass an unset optional plugin option through as the literal "${user_config.x}".
const setting = (name) => {
  const value = process.env[name]?.trim();
  return value && !/^\$\{.*\}$/.test(value) ? value : undefined;
};

const baseUrl = setting('FEATUREHUB_URL')?.replace(/\/+$/, '').replace(/\/mr-api$/, '');
const writeAccess = setting('FEATUREHUB_WRITE_ACCESS') === 'ask' ? 'ask' : 'off';

const client = createClient({
  baseUrl,
  token: setting('FEATUREHUB_ADMIN_TOKEN'),
  email: setting('FEATUREHUB_EMAIL'),
  password: setting('FEATUREHUB_PASSWORD'),
});

const server = new McpServer({ name: 'featurehub', version: '0.2.0' });
registerTools(server, client, { writeAccess });

await server.connect(new StdioServerTransport());
