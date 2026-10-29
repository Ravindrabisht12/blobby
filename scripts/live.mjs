// Drives a running Blobby app through the MCP server: elicitation picker, live edits, screenshot.
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const client = new Client({ name: 'live', version: '1' }, { capabilities: { elicitation: {} } });
client.setRequestHandler(ElicitRequestSchema, async (req) => {
  console.log('ELICIT:', req.params.message, JSON.stringify(req.params.requestedSchema.properties.project.enumNames));
  return { action: 'accept', content: { project: req.params.requestedSchema.properties.project.enum[1] } };
});
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/mcp/server.js'], env: process.env }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  for (const c of r.content) {
    if (c.type === 'text') console.log(`# ${name}${r.isError ? ' ERROR' : ''}: ${c.text.slice(0, 300)}`);
    if (c.type === 'image') { const f = `${process.env.OUT}/${name}-${Date.now()}.jpg`; fs.writeFileSync(f, Buffer.from(c.data, 'base64')); console.log(`# ${name}: image -> ${f}`); }
  }
  return r;
};
await call('create_project', { name: 'Other Co' });
await call('create_page', { name: 'Pricing', project_name_suggestion: 'Acme Coffee' }); // picker -> first existing
await call('write_html', { project: 'acme', page: 'pricing', html: '<section class="wrap" style="padding:80px 24px"><h1 style="font-family:var(--font-display);font-size:56px">Simple pricing</h1><p>One bag or four, shipped free.</p></section>' });
await call('get_feedback', {});
await call('get_screenshot', { project: 'acme', page: 'landing', device: 'mobile' });
await client.close();
