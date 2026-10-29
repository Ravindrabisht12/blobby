// End-to-end over the app's HTTP MCP endpoint: analyze a real site, build with known bugs, QA catches them.
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const home = process.env.BLOBBY_HOME;
const cfg = JSON.parse(fs.readFileSync(path.join(home, '.config.json'), 'utf8'));
const client = new Client({ name: 'live-http', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${cfg.mcpPort}/mcp/${cfg.mcpKey}`)));
let n = 0;
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  for (const c of r.content) {
    if (c.type === 'text') console.log(`# ${name}${r.isError ? ' ERROR' : ''}: ${c.text.slice(0, Number(process.env.MAX || 700))}`);
    if (c.type === 'image') { const f = `${process.env.OUT}/${name}-${n++}.jpg`; fs.writeFileSync(f, Buffer.from(c.data, 'base64')); console.log(`# ${name}: image -> ${f}`); }
  }
  return r;
};
await call('analyze_site', { url: process.env.SITE || 'liftcro.io' });
await call('create_page', { name: 'Landing', project_name_suggestion: 'LiftCRO', brief: { goal: 'Book CRO audits', site: 'liftcro.io', sections: ['Hero with audit CTA'], must_haves: ['Lime CTA button', 'Headline about conversion lift'] } });
await call('write_html', { project: 'liftcro', page: 'landing', html: '<section class="hero"><h1>Lift your conversion rate</h1><p class="faint">Low contrast text that should fail</p><div class="wide">too wide</div><img src="../assets/missing.png"><a class="btn" href="#">Book</a></section>' });
await call('set_css', { project: 'liftcro', page: 'landing', css: '.hero{padding:80px 24px}.faint{color:#ddd}.wide{width:1600px;background:#eee}.btn{font-size:10px}' });
await call('qa_check', { project: 'liftcro', page: 'landing', devices: ['desktop', 'mobile'] });
await client.close();
