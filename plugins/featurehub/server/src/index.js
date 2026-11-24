import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createClient } from './client.js';
import { registerTools } from './tools.js';

const baseUrl = process.env.FEATUREHUB_URL?.trim().replace(/\/+$/, '').replace(/\/mr-api$/, '');
const token = process.env.FEATUREHUB_ADMIN_TOKEN?.trim();
const readOnly = /^(1|true|yes)$/i.test(process.env.FEATUREHUB_READ_ONLY ?? '');

const server = new McpServer({ name: 'featurehub', version: '0.1.0' });
registerTools(server, createClient({ baseUrl, token }), { readOnly });

await server.connect(new StdioServerTransport());
