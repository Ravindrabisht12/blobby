// Starts the MCP server over stdio against a temp BLOBBY_HOME and drives a short design session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const home = process.env.BLOBBY_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'blobby-'));
const transport = new StdioClientTransport({ command: process.execPath, args: ['src/mcp/server.js'], env: { ...process.env, BLOBBY_HOME: home } });
const client = new Client({ name: 'smoke', version: '1' });
await client.connect(transport);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  console.log(`\n# ${name}${r.isError ? ' (ERROR)' : ''}\n${t.slice(0, 600)}`);
  return { r, t };
};
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
const brief = { goal: 'Get signups', sections: ['Hero'], must_haves: ['Headline says ship faster'] };
await call('create_page', { name: 'Landing', project_name_suggestion: 'Acme', brief }); // no projects -> auto-create
await call('create_project', { name: 'Other Co' });
await call('create_page', { name: 'Pricing', brief }); // >1 project, no elicitation -> asks
await call('get_brief', { project: 'acme', page: 'landing' });
await call('set_brand', { project: 'acme', vars: { 'color-primary': '#0a7' } });
await call('write_html', { project: 'acme', page: 'landing', html: '<section class="hero"><h1>Ship faster</h1><a class="btn" href="#">Start</a></section>' });
await call('set_css', { project: 'acme', page: 'landing', css: '.hero{min-height:100vh;padding:120px 24px}' });
const { t } = await call('get_tree', { project: 'acme', page: 'landing' });
const h1 = t.match(/h1 #(\w+)/)[1];
await call('set_text', { project: 'acme', page: 'landing', node_id: h1, text: 'Ship 10x faster' });
await call('get_feedback', {});
await call('export_page', { project: 'acme', page: 'landing' });
await client.close();
if (!process.env.BLOBBY_HOME) fs.rmSync(home, { recursive: true, force: true });
