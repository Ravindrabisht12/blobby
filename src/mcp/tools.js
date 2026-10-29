// Blobby MCP tools. Transport-agnostic: used by the stdio server (src/mcp/server.js) and by the
// HTTP endpoint inside the app (src/main/main.js).
//
// `host` talks to the running app (screenshots, site analysis, QA, selection, live follow):
//   host.running() -> bool, host.ensure() -> bool (start the app if needed), host.call(method, params)

import fs from 'node:fs';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as store from '../shared/store.js';

export const INSTRUCTIONS = `Blobby is the user's design canvas. Designs are real HTML + CSS pages inside projects, shown live in the Blobby app on Desktop/Tablet/Mobile artboards. The user watches you build. The goal is to deliver exactly what the client asked for, in one go, with nothing that looks generic or random.

FOLLOW THIS WORKFLOW EVERY TIME YOU CREATE OR REDESIGN A PAGE

1. UNDERSTAND. Work out what the user wants: the site/brand, the page type, goal, audience, the sections they named, must-haves, tone and the primary CTA. If something important is truly unknown and can't be inferred, ask one short question. Otherwise make sensible, stated assumptions.

2. RESEARCH THE REAL BRAND. If there is a client website, call analyze_site first. Use what it returns: the real colors (by visual weight), fonts, button shape and style, logo (add_asset it), product/hero images (add_asset them), nav labels, voice and real facts from the copy. Match the existing site's look unless the user asks for a new direction. Never invent a palette for a brand that already has one.

3. BRIEF. Call create_page with a complete "brief": goal, audience, sections (in order), must_haves (each one specific and checkable), cta, tone, brand_notes. The brief is saved and QA checks against it.

4. BRAND TOKENS. Call set_brand with the real colors, fonts (Google Fonts css2 names), radius and container width. Use var(--…) tokens in all CSS.

5. BUILD section by section, in brief order: one write_html per section, plus set_css (mode "append") with that section's styles, including its @media (max-width: 768px) rules. Write real, specific copy for this business (no lorem ipsum, no "Feature one"). Use real images via add_asset. When you have none, use tasteful CSS/SVG art that fits the brand, never grey boxes.

6. QA LOOP (required). Call qa_check. It renders desktop, tablet and mobile, finds layout/contrast/content bugs and returns screenshots with the brief. Then:
   - fix every "error" and every warning that is a real problem
   - compare the screenshots against EACH brief must-have and against the client's site, and fix whatever doesn't match (spacing, hierarchy, alignment, brand fidelity, mobile layout)
   - call qa_check again
   Repeat until there are no errors and every must-have is visibly met (at most 4 rounds). Don't stop after the first build.

7. REPORT. Tell the user briefly what you built, which must-haves you checked, and any assumptions you made.

EDITING
get_tree lists element ids (#b1a2b3c). Use write_html with target_id + position, update_styles, set_text, set_attributes or delete_nodes. undo reverts the last change. Never set or remove data-b-id attributes. After edits, run qa_check again.

FEEDBACK
The user pins comments to elements in Blobby. When they say "apply my feedback" (or similar), call get_feedback. Apply every item exactly, run qa_check, then call resolve_feedback for each item with a one-line reply. get_selection returns the element the user has selected right now ("make this bigger").

CRAFT
Use semantic HTML and class-based CSS in set_css. Layouts are responsive (grid/flex, clamp() type). Center content in a max-width var(--container). Give it a clear type scale, generous consistent spacing (8px grid; 72-120px section padding on desktop, 48-64px on mobile) and one consistent primary button style. Add hover/focus states and subtle transitions. CSS-only interactivity (details/summary, :target, checkbox tabs) is preferred; small inline scripts only when needed. Tap targets are at least 44px on mobile, and text contrast meets WCAG AA.`;

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
  };

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
    description: "Open a client's live website and extract its real brand: colors by visual weight, CSS variables, typography (h1/h2/body/nav), button styles, logo (SVG or image URL), main images, nav labels, headings and copy, plus desktop and mobile screenshots. Call this before designing for any existing brand.",
    inputSchema: { url: z.string().describe('e.g. "acme.com" or a specific page URL') },
  }, async ({ url }) => {
    await needApp('analyze_site');
    const res = await host.call('analyzeSite', { url }, { timeout: 90000 });
    const content = [{ type: 'text', text: JSON.stringify(res.data, null, 2) }];
    for (const s of res.screenshots) {
      content.push({ type: 'text', text: s.label });
      content.push({ type: 'image', data: s.data, mimeType: s.mimeType });
    }
    content.push({ type: 'text', text: 'Next: add_asset the logo and the key images, set_brand from these colors and fonts, and match the button style and voice.' });
    return { content };
  });

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
        ? 'The brand is still the default. Run analyze_site on the client site (if any), then set_brand, then build section by section, then qa_check.'
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
    description: 'Get the page body HTML and page CSS, or the outerHTML of one element.',
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
    description: 'Set inline styles on elements (camelCase or kebab-case; null removes). Good for one-off tweaks. Prefer set_css for anything reusable.',
    inputSchema: { project: projectArg, page: pageArg, node_ids: z.array(z.string()), styles: z.record(z.string(), z.string().nullable()) },
  }, async ({ project, page, node_ids, styles }) => {
    const res = store.updateStyles(project, page, { nodeIds: node_ids, styles });
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
    description: 'Add an image/logo/font to the project from a URL, a local file or raw SVG markup. Returns the path to use in HTML (src="../assets/logo.svg") and CSS.',
    inputSchema: {
      project: projectArg,
      url: z.string().optional(),
      file_path: z.string().optional(),
      svg: z.string().optional().describe('Raw <svg> markup, e.g. a logo from analyze_site'),
      filename: z.string().optional().describe('Name to save as, e.g. "logo.svg"'),
    },
  }, async ({ project, url, file_path, svg, filename }) => {
    if (file_path) return text(store.addAsset(project, { sourcePath: file_path, filename }));
    if (svg) return text(store.addAsset(project, { filename: filename || 'logo.svg', data: Buffer.from(svg).toString('base64') }));
    if (!url) throw new Error('Pass url, file_path or svg');
    const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' } });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    let name = filename || decodeURIComponent(new URL(url).pathname.split('/').pop() || 'asset');
    if (!/\.\w{2,5}$/.test(name)) {
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif', 'image/avif': 'avif' }[(res.headers.get('content-type') || '').split(';')[0]];
      if (ext) name += '.' + ext;
    }
    return text(store.addAsset(project, { filename: name, data: buf.toString('base64') }));
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
    description: 'Brief → real brand → build → QA loop',
    argsSchema: { request: z.string().describe('What to design, e.g. "Landing page for acme.com focused on subscriptions"') },
  }, ({ request }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `${request}\n\nUse Blobby and follow its workflow fully: understand → analyze_site (if there's a site) → create_page with a complete brief → set_brand → build section by section → qa_check loop until it passes and every must-have is met → report.` } }],
  }));

  server.registerPrompt('apply_feedback', {
    title: 'Apply my Blobby feedback',
    description: 'Apply all open feedback pins, QA, and resolve them',
  }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'Apply my Blobby feedback: get_feedback, make every change, run qa_check, then resolve_feedback each item with a short reply.' } }],
  }));

  return server;
}
