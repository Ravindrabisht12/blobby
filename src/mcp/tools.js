// Blobby MCP tools. Transport-agnostic: used by the stdio server (src/mcp/server.js) and by the
// HTTP endpoint inside the app (src/main/main.js).
//
// `host` talks to the running app (screenshots, site analysis, QA, selection, live follow):
//   host.running() -> bool, host.ensure() -> bool (start the app if needed), host.call(method, params)

import fs from 'node:fs';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as store from '../shared/store.js';
import { findImages, findLogos, downloadAsset, playbook, PLAYBOOK_TYPES, IMAGE_FILE } from './research.js';

export const INSTRUCTIONS = `Blobby is the user's design canvas. Designs are real HTML + CSS pages inside projects, shown live in the Blobby app on Desktop/Tablet/Mobile artboards. The user watches you build. The goal: the first version already looks like it was designed for THIS person or brand, with their real content, photos and logos. Nothing generic, nothing placeholder.

FOLLOW THIS WORKFLOW EVERY TIME YOU CREATE OR REDESIGN A PAGE

1. UNDERSTAND. Work out who it's for, the page type, goal, audience, sections they named, must-haves, tone and the primary CTA. Note every source they gave: website, Instagram/YouTube/X/LinkedIn handles, competitors, sites they like, photo folders. If something important is truly unknown, ask one short question. Otherwise state your assumptions.

2. RESEARCH BEFORE DESIGNING. Call create_page first only if you need a project to save assets into; otherwise research first.
   - get_design_playbook for the site type (personal-brand, saas, ecommerce, local, portfolio, event): sections, imagery, type and what to avoid.
   - Existing website: analyze_site with "project" set. It saves the logo and any customer logo strip, and returns real colors, fonts, buttons, images, nav, copy and the page structure.
   - Social profiles: analyze_social for each handle. Use the real name, bio, numbers, links and photos. If posts are hidden behind a login, ask the user for a folder of their photos (e.g. an Instagram data download) and import it with add_asset "folder".
   - References: pick 2-3 best-in-class sites in the same category (use your own web search if you have it, or the playbook's examples) and analyze_site them for layout and rhythm. Borrow structure, never their branding.
   - Look at the photos you have with view_assets and choose the strongest ones for each slot.

3. BRIEF. Call create_page (or set_brief) with a complete brief: goal, audience, sections (in order), must_haves (specific and checkable), cta, tone, brand_notes, references (what you borrow from each), art_direction (layout concept, type pairing, color, mood) and imagery (every image slot -> its real source).

4. BRAND TOKENS. set_brand with the real colors and fonts (Google Fonts css2 names), radius and container width. Use var(--…) tokens in all CSS.

5. BUILD section by section, in brief order: one write_html per section, plus set_css (mode "append") with that section's classes and its @media (max-width: 768px) rules. Write real, specific copy from your research (no lorem ipsum, no invented stats or testimonials).
   - Images: every slot gets a real image. In order: the brand's or person's own images -> find_images (free photos with licenses; credit them when required) -> deliberate SVG/CSS art that is clearly a design choice. Never an empty or grey box.
   - Logo strips (clients, partners, sponsors, "as seen in"): real logos only, from analyze_site logoClouds or find_logos. Only companies that really are clients/partners.
   - No inline style="" attributes. Use classes in set_css.

6. QA LOOP (required). Call qa_check. It renders desktop, tablet and mobile, finds layout/contrast/content bugs (including empty image boxes and text-only logo strips) and returns screenshots with the brief. Then:
   - fix every "error" and every warning that is a real problem
   - compare the screenshots against EACH brief must-have, the art direction and the references, and fix whatever doesn't match
   - call qa_check again
   Repeat until there are no errors and every must-have is visibly met (at most 4 rounds).

7. REPORT. Tell the user briefly what you built, which sources you used, which must-haves you checked, any assumptions, and any image credits to keep.

EDITING
get_tree lists element ids (#b1a2b3c). Use write_html with target_id + position, update_styles, set_text, set_attributes or delete_nodes. undo reverts the last change. Never set or remove data-b-id attributes. update_styles writes CSS rules (per breakpoint with "device"), not inline styles. For reusable styling, change the classes with set_css. After edits, run qa_check again.

FEEDBACK
The user pins comments to elements in Blobby. When they say "apply my feedback" (or similar), call get_feedback. Apply every item exactly, run qa_check, then call resolve_feedback for each item with a one-line reply. get_selection returns the element the user has selected right now ("make this bigger").

CRAFT
Use semantic HTML and class-based CSS in set_css. Layouts are responsive (grid/flex, clamp() type). Center content in a max-width var(--container). Give it a clear type scale, generous consistent spacing (8px grid; 72-120px section padding on desktop, 48-64px on mobile) and one consistent primary button style. Vary section layouts (split, full-bleed image, grid, list) instead of repeating identical cards. Add hover/focus states and subtle transitions. CSS-only interactivity (details/summary, :target, checkbox tabs) is preferred; small inline scripts only when needed. Tap targets are at least 44px on mobile, and text contrast meets WCAG AA.`;

export function createBlobbyServer(host) {
  const server = new McpServer({ name: 'blobby', version: '0.2.0' }, { instructions: INSTRUCTIONS });

  const notify = (project, page, tool) => { host.call('activity', { project, page, tool }, { timeout: 1500 }).catch(() => {}); };
  const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
  const fail = (err) => ({ isError: true, content: [{ type: 'text', text: String(err && err.message ? err.message : err) }] });
  const tool = (name, config, handler) => server.registerTool(name, config, async (args, extra) => {
    try { return await handler(args || {}, extra); } catch (err) { return fail(err); }
  });
  const needApp = async (what) => {
    if (!(await host.ensure())) throw new Error(`${what} needs the Blobby app. Ask the user to open Blobby once, then try again.`);
  };

  const projectArg = z.string().describe('Project name or slug (loose match is fine, e.g. "acme")');
  const pageArg = z.string().describe('Page slug or title, e.g. "landing"');
  const briefShape = {
    goal: z.string().describe('What this page must achieve, e.g. "Get visitors to start a coffee subscription"'),
    audience: z.string().optional(),
    site: z.string().optional().describe('Client website URL'),
    sections: z.array(z.string()).describe('Sections in order, each with its purpose, e.g. "Hero: promise + subscribe CTA + product shot"'),
    must_haves: z.array(z.string()).describe('Specific, checkable requirements from the user/client'),
    cta: z.string().optional().describe('Primary call to action text and target'),
    tone: z.string().optional(),
    brand_notes: z.string().optional().describe('What you took from analyze_site: colors, fonts, button style, imagery'),
    assumptions: z.array(z.string()).optional(),
    references: z.array(z.string()).optional().describe('Sites studied and what you borrow from each, e.g. "linear.app: alternating feature rows with UI crops"'),
    art_direction: z.string().optional().describe('Layout concept, type pairing, color use and mood'),
    imagery: z.array(z.string()).optional().describe('Each image slot and its real source, e.g. "Hero: ../assets/ig-3.jpg (action shot from Instagram)"'),
  };

  // Shows pictures to the AI as one numbered contact sheet (needs the app), or as small images.
  async function sheet(items, columns) {
    if (items.length && (await host.ensure().catch(() => false))) {
      try {
        const img = await host.call('contactSheet', { items, columns }, { timeout: 60000 });
        return [{ type: 'image', data: img.data, mimeType: img.mimeType }];
      } catch { /* fall through */ }
    }
    return [];
  }

  // ---------- projects ----------

  tool('list_projects', {
    description: 'List Blobby projects with their pages and open feedback counts.',
    inputSchema: {},
  }, async () => {
    const projects = store.listProjects().map((p) => ({
      project: p.slug, name: p.name, site: p.site, pages: p.pages.map((x) => x.slug),
      openFeedback: store.listFeedback(p.slug).length, updatedAt: p.updatedAt,
    }));
    return text(projects.length ? projects : 'No projects yet. create_page creates one.');
  });

  tool('create_project', {
    description: 'Create a new project (usually one per client/site). Prefer create_page, which asks the user which project to use.',
    inputSchema: { name: z.string(), site: z.string().optional(), description: z.string().optional() },
  }, async ({ name, site, description }) => {
    const p = store.createProject({ name, site, description });
    return text({ created: p.slug, name: p.name });
  });

  // Picks the project. Asks the user via MCP elicitation when the client supports it.
  async function chooseProject({ project, suggestedName, site }) {
    if (project) return store.findProject(project) || store.createProject({ name: project, site });
    const projects = store.listProjects();
    const newName = suggestedName || (site ? site.replace(/^https?:\/\/(www\.)?/, '').split(/[/.]/)[0] : 'New project');
    if (!projects.length) return store.createProject({ name: newName, site });
    const caps = server.server.getClientCapabilities();
    if (!caps || !caps.elicitation) {
      const list = projects.map((p) => `- ${p.slug} (${p.name}${p.site ? ', ' + p.site : ''})`).join('\n');
      throw new Error(`NEEDS_USER_CHOICE: Ask the user which Blobby project to use, then call create_page again with "project".\nExisting projects:\n${list}\nOr offer a new project named "${newName}" (pass that name as "project" to create it).`);
    }
    const NEW = '__new__';
    const answer = await server.server.elicitInput({
      message: `Which Blobby project should this go in?`,
      requestedSchema: {
        type: 'object',
        properties: {
          project: {
            type: 'string', title: 'Project',
            enum: [NEW, ...projects.map((p) => p.slug)],
            enumNames: [`New project: ${newName}`, ...projects.map((p) => p.name)],
          },
        },
        required: ['project'],
      },
    });
    if (answer.action !== 'accept' || !answer.content) throw new Error('The user cancelled choosing a project. Ask them which project to use.');
    if (answer.content.project === NEW) return store.createProject({ name: newName, site });
    return store.requireProject(answer.content.project);
  }

  tool('analyze_site', {
    description: "Open a live website and read it: real colors by visual weight, CSS variables, typography, button styles, logo, customer/partner logo strips (logoClouds), main images, nav, headings, copy and the page structure section by section (sections), plus desktop and mobile screenshots. Use it on the client's site (with project, to save the logo and logo strip) and on 2-3 reference sites for layout ideas.",
    inputSchema: {
      url: z.string().describe('e.g. "acme.com" or a specific page URL'),
      project: projectArg.optional().describe('Save the logo and logo-strip logos into this project\'s assets. Leave empty when studying a reference site'),
    },
  }, async ({ url, project }) => {
    await needApp('analyze_site');
    const res = await host.call('analyzeSite', { url }, { timeout: 90000 });
    const data = res.data;
    const saved = [];
    const save = async (item, name) => {
      try {
        const r = item.svg
          ? store.addAsset(project, { filename: `${name}.svg`, data: Buffer.from(item.svg.includes('xmlns=') ? item.svg : item.svg.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"')).toString('base64') })
          : await downloadAsset(project, item.src, name);
        saved.push(r.path);
        return r.path;
      } catch (err) { return `not saved: ${err.message}`; }
    };
    if (project && data.logo) data.logo = { ...data.logo, svg: undefined, saved: await save(data.logo, 'logo') };
    for (const [i, cloud] of (data.logoClouds || []).entries()) {
      for (const logo of cloud.logos) {
        if (project) logo.saved = await save(logo, `client-${i + 1}-${store.slugify(logo.name || 'logo').slice(0, 30)}`);
        delete logo.svg;
      }
    }
    if (!project && data.logoClouds?.length) data.logoCloudsNote = 'Pass "project" to save these logos (SVG markup is left out here).';
    const content = [{ type: 'text', text: JSON.stringify(data, null, 2) }];
    for (const s of res.screenshots) {
      content.push({ type: 'text', text: s.label });
      content.push({ type: 'image', data: s.data, mimeType: s.mimeType });
    }
    content.push({ type: 'text', text: project
      ? `Saved ${saved.length} asset(s) to ${project}. Next: add_asset the key images, set_brand from these colors and fonts, and match the button style, structure and voice.`
      : 'For a client site: call again with "project" to save its logo and logo strip, then set_brand. For a reference site: borrow structure and rhythm (see "sections"), never its branding.' });
    return { content };
  });

  tool('analyze_social', {
    description: 'Read a public social profile as a logged-out visitor: Instagram, YouTube, X, TikTok, LinkedIn, Linktree, Behance, etc. Returns name, bio, counts, links, structured data, visible photos (with alt text) and a screenshot. With "project" and save_photos, downloads the profile picture and visible photos into the project. Use it for personal brands, creators and local businesses.',
    inputSchema: {
      url: z.string().describe('Profile URL, or "@handle" for Instagram'),
      project: projectArg.optional(),
      save_photos: z.number().int().min(0).max(24).optional().describe('How many visible photos to save (needs project). Default 12 when project is set'),
    },
  }, async ({ url, project, save_photos }) => {
    await needApp('analyze_social');
    const target = /^@/.test(url) ? `https://www.instagram.com/${url.slice(1)}/` : /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const res = await host.call('analyzeProfile', { url: target }, { timeout: 90000 });
    const data = res.data;
    const saved = [];
    if (project) {
      const handle = store.slugify(new URL(target).pathname.split('/').filter(Boolean)[0] || new URL(target).hostname).slice(0, 24);
      if (data.profileImage) { try { saved.push((await downloadAsset(project, data.profileImage, `${handle}-profile`)).path); } catch { /* optional */ } }
      for (const [i, img] of data.images.slice(0, save_photos ?? 12).entries()) {
        try { img.saved = (await downloadAsset(project, img.src, `${handle}-${i + 1}`)).path; saved.push(img.saved); } catch (err) { img.saved = `not saved: ${err.message}`; }
      }
    }
    const content = [{ type: 'text', text: JSON.stringify(data, null, 2) }];
    for (const s of res.screenshots) {
      content.push({ type: 'text', text: s.label });
      content.push({ type: 'image', data: s.data, mimeType: s.mimeType });
    }
    content.push(...(await sheet(data.images.slice(0, 16).map((img, i) => ({ url: img.src, label: img.alt || `photo ${i + 1}` })))));
    const hints = [];
    if (data.loginWall || data.images.length < 4) hints.push('The platform hides most photos from logged-out visitors. Ask the user for a folder of their best photos (Instagram: Settings > Your activity > Download your information), then add_asset with "folder".');
    if (saved.length) hints.push(`Saved ${saved.length} image(s): ${saved.join(', ')}. Use view_assets to pick the best ones for each slot.`);
    hints.push('Use only the person\'s own photos to show them. Pull real facts (name, role, team, numbers, links) from the bio and text, and confirm anything unclear with the user.');
    content.push({ type: 'text', text: hints.join('\n') });
    return { content };
  });

  tool('find_images', {
    description: 'Search free-to-use photos (Wikimedia Commons, Openverse, and Pexels when a key is set) and show them as a numbered contact sheet with license and credit. Then add_asset the ones you pick (url). Use for mood, places, objects and backgrounds, never to stand in for a real person, product or team.',
    inputSchema: {
      query: z.string().describe('Specific and visual, e.g. "cricket stadium floodlights night" rather than "sports"'),
      count: z.number().int().min(1).max(16).optional().describe('Default 8'),
      orientation: z.enum(['landscape', 'portrait', 'square']).optional(),
    },
  }, async ({ query, count = 8, orientation }) => {
    const { results, notes } = await findImages({ query, count, orientation });
    const content = [{ type: 'text', text: JSON.stringify({ query, results: results.map(({ thumb, ...r }) => r), notes }, null, 2) }];
    content.push(...(await sheet(results.map((r) => ({ url: r.thumb || r.url, label: `${r.title} (${r.width}x${r.height})` })))));
    content.push({ type: 'text', text: results.length
      ? 'Pick by number, then add_asset with its "url" and a clear filename. Keep the credit when the license needs attribution (CC BY / CC BY-SA): add it to a small credits line in the footer.'
      : 'Nothing found. Try a more concrete query, or use the brand\'s own images.' });
    return { content };
  });

  tool('find_logos', {
    description: 'Get real company logos for logo strips (customers, partners, sponsors, press, integrations) and save them as project assets. Tries the company\'s own site header (wordmark), then Simple Icons (brand mark). Pass domains for best results. Only use companies that really are clients/partners.',
    inputSchema: {
      project: projectArg,
      companies: z.array(z.object({ name: z.string(), domain: z.string().optional().describe('e.g. "stripe.com"') })).min(1).max(20),
      color: z.string().optional().describe('Make every logo one color for a calm strip, e.g. "#6b7280" or "#ffffff" on dark'),
      prefer: z.enum(['wordmark', 'mark']).optional().describe('wordmark (default) for logo strips, mark for small icons like integrations'),
    },
  }, async ({ project, companies, color, prefer }) => {
    const p = store.requireProject(project);
    const logos = await findLogos(p.slug, companies, { color, prefer });
    const ok = logos.filter((l) => l.path);
    const content = [{ type: 'text', text: JSON.stringify(logos.map(({ file, ...l }) => l), null, 2) }];
    content.push(...(await sheet(ok.map((l) => ({ file: l.file, label: l.name })), 5)));
    content.push({ type: 'text', text: 'Use as <img src="../assets/…" alt="Company"> with one shared height (e.g. 24-32px, width auto). Check the preview: replace any that look wrong or are white-on-white.' });
    return { content };
  });

  tool('view_assets', {
    description: 'See the images saved in a project as one numbered contact sheet, to choose the best photo for each slot.',
    inputSchema: { project: projectArg, filter: z.string().optional().describe('Only files whose name contains this, e.g. "ig-" or "logo"') },
  }, async ({ project, filter }) => {
    const p = store.requireProject(project);
    const dir = `${store.projectDir(p.slug)}/assets`;
    const files = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => IMAGE_FILE.test(f) && (!filter || f.includes(filter))).slice(0, 40);
    if (!files.length) return text('No images in this project yet. Use analyze_site / analyze_social with "project", find_images, or add_asset.');
    const list = files.map((f, i) => `${i + 1}. ../assets/${f}`).join('\n');
    const imgs = await sheet(files.map((f) => ({ file: `${dir}/${f}`, label: f })));
    return { content: [{ type: 'text', text: list }, ...imgs, ...(imgs.length ? [] : [{ type: 'text', text: '(Open the Blobby app to see previews.)' }])] };
  });

  tool('get_design_playbook', {
    description: `How great sites of a given type are built: research steps, section recipe, imagery, typography, color and signature details, plus what makes a page look generic. Call before the brief. Types: ${PLAYBOOK_TYPES.join(', ')}.`,
    inputSchema: { site_type: z.enum(PLAYBOOK_TYPES).optional() },
  }, async ({ site_type }) => text(playbook(site_type)));

  tool('create_page', {
    description: 'Start a new design page with its brief. Leave "project" empty when the user did not name one: Blobby asks them to pick an existing project or create a new one. Opens the page live in the Blobby app.',
    inputSchema: {
      name: z.string().describe('Page name, e.g. "Landing page" or "Pricing v2"'),
      brief: z.object(briefShape).describe('What the client wants. QA checks against it'),
      project: projectArg.optional(),
      project_name_suggestion: z.string().optional().describe('Name to suggest if a new project is needed, e.g. the brand name'),
    },
  }, async ({ name, brief, project, project_name_suggestion }) => {
    const p = await chooseProject({ project, suggestedName: project_name_suggestion, site: brief.site });
    const res = store.createPage(p.slug, { name });
    store.setBrief(res.project, res.page, brief);
    const opened = await host.ensure().catch(() => false);
    if (opened) host.call('open', { project: res.project, page: res.page }, { timeout: 3000 }).catch(() => {});
    const meta = store.readProjectMeta(p.slug);
    const defaultBrand = meta.tokens?.vars?.['--color-primary'] === '#16161a';
    return text({
      project: res.project, page: res.page, appOpen: opened, brand: meta.tokens,
      next: defaultBrand
        ? 'The brand is still the default. Research first if you haven\'t: analyze_site / analyze_social with this project, view_assets, then set_brand, build section by section with real images and logos, then qa_check.'
        : 'Build section by section with write_html + set_css, then qa_check.',
    });
  });

  tool('get_brief', {
    description: 'Read the saved brief for a page.',
    inputSchema: { project: projectArg, page: pageArg },
  }, async ({ project, page }) => text(store.getBrief(project, page) || 'No brief saved. Use set_brief.'));

  tool('set_brief', {
    description: 'Update the brief for a page (merges fields), e.g. when the user changes requirements.',
    inputSchema: { project: projectArg, page: pageArg, brief: z.object(briefShape).partial() },
  }, async ({ project, page, brief }) => text(store.setBrief(project, page, brief)));

  tool('get_project', {
    description: 'Project details: brand tokens, pages and open feedback.',
    inputSchema: { project: projectArg },
  }, async ({ project }) => {
    const p = store.requireProject(project);
    return text({ project: p.slug, name: p.name, site: p.site, tokens: p.tokens, pages: p.pages.map((x) => ({ page: x.slug, title: x.title, updatedAt: x.updatedAt })), openFeedback: store.listFeedback(p.slug).length });
  });

  tool('set_brand', {
    description: 'Set the project brand tokens (CSS custom properties on :root) and Google Fonts. Applies to every page in the project. Common vars: color-bg, color-fg, color-muted, color-primary, color-on-primary, color-accent, color-line, color-surface, font-sans, font-display, radius, radius-button, container.',
    inputSchema: {
      project: projectArg,
      vars: z.record(z.string(), z.string()).describe('e.g. {"color-primary":"#191919","font-display":"\\"Fraunces\\", serif"}'),
      fonts: z.array(z.string()).optional().describe('Google Fonts css2 families, e.g. ["Inter:wght@400;600;700","Fraunces:opsz,wght@9..144,600"]'),
      replace: z.boolean().optional().describe('Replace all tokens instead of merging'),
    },
  }, async ({ project, vars, fonts, replace }) => {
    const tokens = store.setTokens(project, { vars, fonts }, { replace });
    notify(store.requireProject(project).slug, null, 'set_brand');
    return text({ tokens });
  });

  // ---------- reading & editing ----------

  tool('get_tree', {
    description: 'Outline of a page: tag.classes #element-id "text". Use the ids with write_html target_id, update_styles, set_text, delete_nodes.',
    inputSchema: { project: projectArg, page: pageArg, max_depth: z.number().int().optional() },
  }, async ({ project, page, max_depth }) => text(store.getTree(project, page, { maxDepth: max_depth ?? 8 })));

  tool('get_html', {
    description: 'Get the page body HTML, page CSS and edits_css (per-element rules from canvas edits and update_styles), or the outerHTML of one element.',
    inputSchema: { project: projectArg, page: pageArg, node_id: z.string().optional() },
  }, async ({ project, page, node_id }) => text(store.getPageHtml(project, page, { nodeId: node_id })));

  tool('write_html', {
    description: 'Insert HTML into a page. Without target_id it appends to <body>. Use one section per call.',
    inputSchema: {
      project: projectArg, page: pageArg, html: z.string(),
      target_id: z.string().optional().describe('Element id from get_tree'),
      position: z.enum(['append', 'prepend', 'before', 'after', 'replace', 'inner']).optional().describe('Relative to target (default append = last child)'),
    },
  }, async ({ project, page, html, target_id, position }) => {
    const res = store.writeHtml(project, page, { html, targetId: target_id, position });
    notify(res.project, res.page, 'write_html');
    return text(res);
  });

  tool('set_css', {
    description: 'Add to or replace the page stylesheet. Use "append" to add the CSS for each new section.',
    inputSchema: { project: projectArg, page: pageArg, css: z.string(), mode: z.enum(['append', 'replace']).optional() },
  }, async ({ project, page, css, mode }) => {
    const res = store.setCss(project, page, { css, mode });
    notify(res.project, res.page, 'set_css');
    return text(res);
  });

  tool('update_styles', {
    description: 'Style specific elements (camelCase or kebab-case; null removes). Saved as CSS rules on the element\'s id in the stylesheet, never inline. "device" scopes the change: desktop = all sizes (default), tablet = 1023px and down, mobile = 767px and down. For anything reusable, change the classes with set_css instead.',
    inputSchema: {
      project: projectArg, page: pageArg, node_ids: z.array(z.string()), styles: z.record(z.string(), z.string().nullable()),
      device: z.enum(['desktop', 'tablet', 'mobile']).optional(),
    },
  }, async ({ project, page, node_ids, styles, device }) => {
    const res = store.updateStyles(project, page, { nodeIds: node_ids, styles, device });
    notify(store.requireProject(project).slug, page, 'update_styles');
    return text(res);
  });

  tool('set_text', {
    description: 'Replace the text content of an element.',
    inputSchema: { project: projectArg, page: pageArg, node_id: z.string(), text: z.string() },
  }, async ({ project, page, node_id, text: value }) => {
    const res = store.setText(project, page, { nodeId: node_id, text: value });
    notify(store.requireProject(project).slug, page, 'set_text');
    return text(res);
  });

  tool('set_attributes', {
    description: 'Set or remove (null) attributes on an element, e.g. href, src, alt, class.',
    inputSchema: { project: projectArg, page: pageArg, node_id: z.string(), attributes: z.record(z.string(), z.string().nullable()) },
  }, async ({ project, page, node_id, attributes }) => {
    const res = store.setAttributes(project, page, { nodeId: node_id, attributes });
    notify(store.requireProject(project).slug, page, 'set_attributes');
    return text(res);
  });

  tool('delete_nodes', {
    description: 'Delete elements by id.',
    inputSchema: { project: projectArg, page: pageArg, node_ids: z.array(z.string()) },
  }, async ({ project, page, node_ids }) => {
    const res = store.deleteNodes(project, page, { nodeIds: node_ids });
    notify(store.requireProject(project).slug, page, 'delete_nodes');
    return text(res);
  });

  tool('undo', {
    description: 'Revert the last change to a page.',
    inputSchema: { project: projectArg, page: pageArg },
  }, async ({ project, page }) => {
    const res = store.undo(project, page);
    notify(res.project, res.page, 'undo');
    return text(res);
  });

  // ---------- seeing & checking ----------

  tool('get_screenshot', {
    description: 'Render the page and return an image. For the full build check use qa_check instead.',
    inputSchema: {
      project: projectArg, page: pageArg,
      device: z.enum(['desktop', 'tablet', 'mobile']).optional(),
      full_page: z.boolean().optional().describe('Whole page (default) or just the first screen'),
    },
  }, async ({ project, page, device = 'desktop', full_page = true }) => {
    await needApp('get_screenshot');
    const p = store.requireProject(project);
    const pg = store.requirePage(p.slug, page);
    const shot = await host.call('screenshot', { project: p.slug, page: pg.slug, device, full: full_page });
    return { content: [
      { type: 'image', data: shot.data, mimeType: shot.mimeType },
      { type: 'text', text: `${p.slug}/${pg.slug} on ${device} (${shot.width}x${shot.height}px)` },
    ] };
  });

  tool('qa_check', {
    description: 'Required after building or editing. Renders the page on desktop, tablet and mobile, runs automated checks (overflow, contrast, broken images, tap targets, tiny text, placeholder copy, headings, clipped content, JS errors, off-brand colors) and returns screenshots plus the brief to verify each must-have. Fix everything, then run it again.',
    inputSchema: {
      project: projectArg, page: pageArg,
      devices: z.array(z.enum(['desktop', 'tablet', 'mobile'])).optional().describe('Default: all three'),
    },
  }, async ({ project, page, devices = ['desktop', 'tablet', 'mobile'] }) => {
    await needApp('qa_check');
    const p = store.requireProject(project);
    const pg = store.requirePage(p.slug, page);
    const res = await host.call('qa', { project: p.slug, page: pg.slug, devices }, { timeout: 120000 });
    const brief = store.getBrief(p.slug, pg.slug);

    // Static brand check: colors hard-coded in page CSS that aren't brand tokens.
    const { css, html } = store.getPageHtml(p.slug, pg.slug);
    const tokenColors = new Set(Object.values(p.tokens?.vars || {}).map((v) => v.toLowerCase()));
    const hard = [...new Set(((css + html).match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi) || []).map((c) => c.toLowerCase()))]
      .filter((c) => !tokenColors.has(c) && !['#fff', '#ffffff', '#000', '#000000'].includes(c));
    const brandIssues = hard.length > 5 ? [{ severity: 'warning', rule: 'off-brand-colors', message: `${hard.length} hard-coded colors are not brand tokens (${hard.slice(0, 8).join(', ')}). Use var(--color-…) or add them with set_brand.` }] : [];
    const inline = (html.match(/<(?!svg|path|g |circle|rect|line|polygon|stop)[a-z][^>]*\sstyle="/gi) || []).length;
    if (inline > 2) brandIssues.push({ severity: 'warning', rule: 'inline-styles', message: `${inline} elements have inline style="" attributes. Move them into classes with set_css.` });
    if (!/<img\b|background(-image)?:[^;]*url\(/i.test(css + html)) brandIssues.push({ severity: 'warning', rule: 'no-images', message: 'The page has no images at all. Unless the brief says otherwise, use real photos (analyze_site, analyze_social, find_images).' });

    let errors = 0;
    let warnings = 0;
    const content = [];
    for (const r of res.results) {
      const issues = [...r.issues, ...(r.device === 'desktop' ? brandIssues : [])];
      errors += issues.filter((i) => i.severity === 'error').length;
      warnings += issues.filter((i) => i.severity === 'warning').length;
      content.push({ type: 'text', text: `## ${r.device} (${r.width}px wide, page ${r.pageHeight}px tall)\n${issues.length ? JSON.stringify(issues, null, 1) : 'No automated issues.'}` });
      content.push({ type: 'image', data: r.screenshot.data, mimeType: r.screenshot.mimeType });
    }
    const verdict = errors ? `FAIL: ${errors} error(s), ${warnings} warning(s). Fix them and run qa_check again.` : warnings ? `PASS WITH WARNINGS: ${warnings} warning(s). Fix the real ones.` : 'Automated checks PASS.';
    content.unshift({ type: 'text', text: `${verdict}\n\nNow review the screenshots against the brief, item by item. Fix anything not clearly met (layout, hierarchy, spacing, brand fidelity, mobile), then run qa_check again until everything passes.\n\nBRIEF:\n${brief ? JSON.stringify(brief, null, 2) : '(no brief saved; call set_brief with what the user asked for)'}` });
    notify(p.slug, pg.slug, 'qa_check');
    return { content };
  });

  tool('get_selection', {
    description: 'The element the user currently has selected in the Blobby app, if any (for requests like "make this bigger").',
    inputSchema: {},
  }, async () => {
    if (!(await host.running())) return text('The Blobby app is not open, so nothing is selected.');
    const sel = await host.call('selection');
    if (!sel) return text('Nothing is selected in Blobby.');
    return text({ ...sel, html: store.getPageHtml(sel.project, sel.page, { nodeId: sel.nodeId }) });
  });

  // ---------- feedback ----------

  tool('get_feedback', {
    description: 'Comments the user pinned to elements in Blobby. Each has the element id, its current HTML, the comment and a screenshot of the element. Apply them, run qa_check, then call resolve_feedback.',
    inputSchema: {
      project: projectArg.optional().describe('Leave empty for all projects'),
      page: z.string().optional(),
      status: z.enum(['open', 'resolved', 'all']).optional(),
    },
  }, async ({ project, page, status = 'open' }) => {
    const items = store.listFeedback(project, { status, page });
    if (!items.length) return text(`No ${status === 'all' ? '' : status + ' '}feedback.`);
    const content = [];
    let images = 0;
    for (const f of items) {
      let html = '';
      try { html = store.getPageHtml(f.project, f.page, { nodeId: f.nodeId }); } catch { html = '(element no longer exists) ' + f.snippet; }
      content.push({ type: 'text', text: JSON.stringify({
        id: f.id, project: f.project, page: f.page, element_id: f.nodeId, element: f.label,
        viewport: f.viewport, comment: f.comment, author: f.author?.name, status: f.status,
        thread: f.replies.map((r) => `${r.ai ? 'AI' : r.author?.name || 'User'}: ${r.text}`),
        current_html: html.slice(0, 3000),
      }, null, 2) });
      if (f.screenshotFile && images < 8 && fs.existsSync(f.screenshotFile)) {
        content.push({ type: 'image', data: fs.readFileSync(f.screenshotFile).toString('base64'), mimeType: 'image/png' });
        images++;
      }
    }
    content.push({ type: 'text', text: 'Apply each item, run qa_check, then resolve_feedback each id with a short reply.' });
    return { content };
  });

  tool('resolve_feedback', {
    description: 'Mark a feedback item done, with a short reply the user sees on the pin.',
    inputSchema: { project: projectArg, id: z.string(), reply: z.string() },
  }, async ({ project, id, reply }) => {
    const res = store.addReply(project, id, { text: reply, ai: true, resolve: true });
    notify(res.project, res.page, 'resolve_feedback');
    return text({ resolved: id });
  });

  tool('reply_feedback', {
    description: 'Reply in a feedback thread without resolving it, e.g. to ask the user a clarifying question about their comment.',
    inputSchema: { project: projectArg, id: z.string(), reply: z.string() },
  }, async ({ project, id, reply }) => {
    const res = store.addReply(project, id, { text: reply, ai: true });
    notify(res.project, res.page, 'reply_feedback');
    return text({ replied: id });
  });

  tool('move_nodes', {
    description: 'Move elements (keeps their ids) before/after a target element, or into it as first/last child.',
    inputSchema: { project: projectArg, page: pageArg, node_ids: z.array(z.string()), target_id: z.string(), position: z.enum(['before', 'after', 'prepend', 'append']) },
  }, async ({ project, page, node_ids, target_id, position }) => {
    const res = store.moveNodes(project, page, { nodeIds: node_ids, targetId: target_id, position });
    notify(store.requireProject(project).slug, page, 'move_nodes');
    return text(res);
  });

  tool('duplicate_page', {
    description: 'Copy a page (e.g. to make a variant "Landing v2"), including its brief.',
    inputSchema: { project: projectArg, page: pageArg, name: z.string().optional() },
  }, async ({ project, page, name }) => {
    const res = store.duplicatePage(project, page, { name });
    notify(res.project, res.page, 'duplicate_page');
    return text(res);
  });

  // ---------- assets & output ----------

  tool('add_asset', {
    description: 'Add an image/logo/font to the project from a URL, a local file, a whole folder of images (e.g. the user\'s photos) or raw SVG markup. Returns the path to use in HTML (src="../assets/logo.svg") and CSS.',
    inputSchema: {
      project: projectArg,
      url: z.string().optional(),
      file_path: z.string().optional(),
      folder: z.string().optional().describe('Import every image in this folder (and its subfolders, up to 60 files)'),
      svg: z.string().optional().describe('Raw <svg> markup, e.g. a logo from analyze_site'),
      filename: z.string().optional().describe('Name to save as, e.g. "logo.svg"'),
    },
  }, async ({ project, url, file_path, folder, svg, filename }) => {
    if (folder) {
      const files = fs.readdirSync(folder, { recursive: true }).map(String).filter((f) => IMAGE_FILE.test(f)).slice(0, 60);
      if (!files.length) throw new Error(`No images (jpg, png, webp, gif, svg, avif) in ${folder}. HEIC photos need converting to JPEG first.`);
      const added = files.map((f) => store.addAsset(project, { sourcePath: `${folder}/${f}`, filename: f.split('/').join('-') }).path);
      return text({ added, next: 'Call view_assets to see them and pick the strongest photo for each slot.' });
    }
    if (file_path) return text(store.addAsset(project, { sourcePath: file_path, filename }));
    if (svg) return text(store.addAsset(project, { filename: filename || 'logo.svg', data: Buffer.from(svg).toString('base64') }));
    if (!url) throw new Error('Pass url, file_path, folder or svg');
    return text(await downloadAsset(project, url, filename));
  });

  tool('export_page', {
    description: 'Export a page as clean, standalone index.html + styles.css (+ assets), with no editor attributes.',
    inputSchema: { project: projectArg, page: pageArg, dest: z.string().optional().describe('Folder to export into (default ~/Blobby/_exports/<project>-<page>)') },
  }, async ({ project, page, dest }) => text(store.exportPage(project, page, { dest })));

  tool('open_in_blobby', {
    description: 'Show a page in the Blobby app (starts it if needed).',
    inputSchema: { project: projectArg, page: pageArg.optional() },
  }, async ({ project, page }) => {
    const p = store.requireProject(project);
    await needApp('open_in_blobby');
    await host.call('open', { project: p.slug, page });
    return text(`Opened ${p.slug}${page ? '/' + page : ''} in Blobby.`);
  });

  // Prompt for clients that show prompt menus (Claude Desktop "+" menu, etc.).
  server.registerPrompt('design_page', {
    title: 'Design a page in Blobby',
    description: 'Research → brief → real brand → build → QA loop',
    argsSchema: { request: z.string().describe('What to design, e.g. "Landing page for acme.com focused on subscriptions"') },
  }, ({ request }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `${request}\n\nUse Blobby and follow its workflow fully: understand → get_design_playbook → research (analyze_site for their site, analyze_social for their profiles, 2-3 reference sites, view_assets) → create_page with a complete brief incl. art_direction and imagery → set_brand → build section by section with real photos and real logos → qa_check loop until it passes and every must-have is met → report.` } }],
  }));

  server.registerPrompt('apply_feedback', {
    title: 'Apply my Blobby feedback',
    description: 'Apply all open feedback pins, QA, and resolve them',
  }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'Apply my Blobby feedback: get_feedback, make every change, run qa_check, then resolve_feedback each item with a short reply.' } }],
  }));

  return server;
}
