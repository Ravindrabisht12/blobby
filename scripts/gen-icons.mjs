import fs from 'node:fs';
const lucide = ['panel-left','panel-right','plug','download','settings','user','log-out','circle-help','keyboard','house','folder','folder-open','file','search','plus','ellipsis','mouse-pointer-2','play','monitor','tablet','smartphone','message-square','message-square-plus','layers','trash-2','copy','pencil','arrow-up','arrow-down','corner-left-up','x','check','rotate-ccw','external-link','users','user-plus','sparkles','image','type','link','square','frame','rectangle-horizontal','triangle','text-cursor-input','chevron-right','chevron-down','key-round','info','zoom-in','book-open','code','terminal','bot','globe','shield-check','scissors','clipboard-paste','maximize','layout-panel-left','hand','clock','layout-grid','list','rows-3','columns-3','graduation-cap','circle-check','minus','share-2','image-plus','square-dashed','chevron-up','zoom-out','scan','message-circle-heart','gift','box','mail','eye'];
const brands = { claude: 'claude', claudecode: 'claudecode', cursor: 'cursor', windsurf: 'windsurf', copilot: 'githubcopilot', gemini: 'googlegemini' };
const out = {};
for (const n of lucide) {
  const f = `node_modules/lucide-static/icons/${n}.svg`;
  if (!fs.existsSync(f)) { console.error('missing', n); continue; }
  const svg = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\s*class="[^"]*"/, '').replace(/\s*width="24"/, '').replace(/\s*height="24"/, '').replace(/\s*\n\s*/g, ' ').replace(/> </g, '><').trim();
  out[n] = svg;
}
const brandOut = {};
for (const [k, n] of Object.entries(brands)) {
  const svg = fs.readFileSync(`node_modules/simple-icons/icons/${n}.svg`, 'utf8').trim();
  const hex = JSON.parse(fs.readFileSync('node_modules/simple-icons/data/simple-icons.json', 'utf8').replace(/^﻿/, '')).find?.((i) => i.slug === n)?.hex;
  brandOut[k] = { svg: svg.replace('<svg ', '<svg fill="currentColor" '), hex };
}
const header = `// Generated from lucide-static (ISC) and simple-icons (CC0). Brand marks belong to their owners and are\n// used only to show which AI apps Blobby works with. Regenerate with the script in the commit history.\n`;
fs.writeFileSync('icons.js', `${header}export const ICON = ${JSON.stringify(out, null, 1)};\n\nexport const BRAND = ${JSON.stringify(brandOut, null, 1)};\n`);
console.log(Object.keys(out).length, 'ui icons;', Object.entries(brandOut).map(([k, v]) => `${k}:${v.hex}`).join(' '));
