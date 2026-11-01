// Scripts that run inside a rendered page (via webContents.executeJavaScript).
// Each is a plain function serialized with toString(), so it must not reference outer scope.

// Reads a live website's real brand: colors by visual weight, type, buttons, logo, imagery, copy.
export function siteProbe() {
  const cs = (el) => getComputedStyle(el);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = cs(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const toHex = (c) => {
    const m = String(c).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
    if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) return null;
    return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  };
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();

  const bg = {};
  const text = {};
  const all = [...document.querySelectorAll('body *')].slice(0, 4000);
  for (const el of all) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const s = cs(el);
    const b = toHex(s.backgroundColor);
    if (b) bg[b] = (bg[b] || 0) + Math.min(r.width * r.height, 3e6);
    if (ownText(el)) { const t = toHex(s.color); if (t) text[t] = (text[t] || 0) + ownText(el).length; }
  }
  const bodyBg = toHex(cs(document.body).backgroundColor) || toHex(cs(document.documentElement).backgroundColor) || '#ffffff';
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([c]) => c);

  const typo = (el) => {
    if (!el) return null;
    const s = cs(el);
    return { family: s.fontFamily, size: s.fontSize, weight: s.fontWeight, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing, transform: s.textTransform, color: toHex(s.color), sample: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 90) };
  };
  const first = (sel) => [...document.querySelectorAll(sel)].find(visible) || null;

  const buttonEls = [...document.querySelectorAll('a, button, input[type=submit], [role=button]')].filter((el) => {
    if (!visible(el)) return false;
    const s = cs(el);
    const filled = toHex(s.backgroundColor) && toHex(s.backgroundColor) !== bodyBg;
    const outlined = parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none';
    const r = el.getBoundingClientRect();
    return (filled || outlined) && r.height >= 28 && r.height <= 90 && el.textContent.trim().length > 1 && el.textContent.trim().length < 40;
  }).slice(0, 8);
  const buttons = buttonEls.map((b) => {
    const s = cs(b);
    return { text: b.textContent.trim().replace(/\s+/g, ' '), background: toHex(s.backgroundColor), color: toHex(s.color), radius: s.borderRadius, padding: s.padding, border: s.border, font: s.fontFamily, weight: s.fontWeight, size: s.fontSize, transform: s.textTransform, height: Math.round(b.getBoundingClientRect().height) };
  });

  const logoEl = first('header [class*="logo" i] img, header [class*="logo" i] svg, [class*="logo" i] img, [class*="logo" i] svg, header a[href="/"] img, header a[href="/"] svg, a[class*="brand" i] img, a[class*="brand" i] svg, img[alt*="logo" i], img[src*="logo" i], header img, header svg');
  let logo = null;
  if (logoEl) {
    if (logoEl.tagName.toLowerCase() === 'svg') {
      const clone = logoEl.cloneNode(true);
      const r = logoEl.getBoundingClientRect();
      if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${Math.round(r.width)} ${Math.round(r.height)}`);
      clone.setAttribute('fill', clone.getAttribute('fill') || cs(logoEl).color);
      logo = { type: 'svg', svg: clone.outerHTML.slice(0, 30000), width: Math.round(r.width), height: Math.round(r.height) };
    } else {
      logo = { type: 'img', src: abs(logoEl.currentSrc || logoEl.src), alt: logoEl.alt, width: logoEl.naturalWidth, height: logoEl.naturalHeight };
    }
  }

  const images = [...document.images].filter((i) => visible(i) && i.naturalWidth >= 300 && !/logo|icon|sprite|pixel/i.test(i.src))
    .map((i) => ({ src: abs(i.currentSrc || i.src), alt: i.alt, width: i.naturalWidth, height: i.naturalHeight, area: i.getBoundingClientRect().width * i.getBoundingClientRect().height }))
    .sort((a, b) => b.area - a.area).slice(0, 12).map(({ area, ...rest }) => rest);
  const bgImages = all.filter(visible).map((el) => cs(el).backgroundImage).filter((v) => v && v.startsWith('url(')).slice(0, 6)
    .map((v) => abs(v.slice(4, -1).replace(/["']/g, '')));

  const cssVars = {};
  for (const sheet of [...document.styleSheets]) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of [...(rules || [])]) {
      if (rule.selectorText && /(^|,)\s*(:root|html|body)\s*($|,)/.test(rule.selectorText)) {
        for (const prop of [...rule.style]) if (prop.startsWith('--') && Object.keys(cssVars).length < 80) cssVars[prop] = rule.style.getPropertyValue(prop).trim();
      }
    }
  }

  // Logo strips ("Trusted by …"): rows of 4+ small, similar-sized images or SVGs outside the header.
  const markName = (m) => m.getAttribute('alt') || m.getAttribute('aria-label') || m.querySelector?.('title')?.textContent
    || m.closest('a')?.getAttribute('aria-label') || m.closest('a')?.getAttribute('title')
    || (m.currentSrc || m.src || '').split('/').pop().split('?')[0].replace(/\.\w+$/, '').replace(/[-_]+/g, ' ') || '';
  const marks = [...document.querySelectorAll('img, svg')].filter((m) => {
    if (!visible(m) || m.closest('header, nav, button') || (m.tagName.toLowerCase() === 'svg' && m.parentElement?.closest('svg'))) return false;
    const r = m.getBoundingClientRect();
    return r.height >= 12 && r.height <= 110 && r.width >= 30 && r.width <= 320;
  }).slice(0, 400);
  const counts = new Map();
  const ups = (m) => { const out = []; for (let p = m.parentElement, i = 0; p && i < 6; p = p.parentElement, i++) out.push(p); return out; };
  for (const m of marks) for (const p of ups(m)) counts.set(p, (counts.get(p) || 0) + 1);
  const rows = new Map();
  for (const m of marks) {
    const row = ups(m).find((p) => counts.get(p) >= 4);
    if (row) rows.set(row, [...(rows.get(row) || []), m]);
  }
  const logoClouds = [...rows.entries()].filter(([, ms]) => {
    const hs = ms.map((m) => m.getBoundingClientRect().height);
    return ms.length >= 4 && Math.max(...hs) / Math.min(...hs) < 3;
  }).slice(0, 3).map(([row, ms]) => {
    const section = row.closest('section') || row.parentElement;
    const label = [...(section?.querySelectorAll('h2, h3, p, span') || [])].map((e) => ownText(e)).find((t) => t.length > 6 && t.length < 90) || '';
    return {
      label,
      logos: ms.slice(0, 16).map((m) => m.tagName.toLowerCase() === 'svg'
        ? { name: markName(m).trim().slice(0, 60), type: 'svg', svg: (() => { const c = m.cloneNode(true); const r = m.getBoundingClientRect(); if (!c.getAttribute('viewBox')) c.setAttribute('viewBox', `0 0 ${Math.round(r.width)} ${Math.round(r.height)}`); c.setAttribute('fill', c.getAttribute('fill') || cs(m).color); return c.outerHTML.slice(0, 20000); })() }
        : { name: markName(m).trim().slice(0, 60), type: 'img', src: abs(m.currentSrc || m.src) }),
    };
  });

  // Page structure, top to bottom: each block's heading, height, background and column layout.
  const sections = (() => {
    let kids = [...(document.querySelector('main') || document.body).children].filter(visible);
    while (kids.length === 1 && kids[0].children.length > 1) kids = [...kids[0].children].filter(visible);
    return kids.filter((el) => el.getBoundingClientRect().height > 120).slice(0, 24).map((el) => {
      const r = el.getBoundingClientRect();
      let cols = 1;
      for (const c of [el, ...el.querySelectorAll('*')].slice(0, 300)) {
        const d = cs(c).display;
        if (!/flex|grid/.test(d)) continue;
        const items = [...c.children].filter((k) => visible(k) && k.getBoundingClientRect().width > 80);
        const tops = items.map((k) => Math.round(k.getBoundingClientRect().top / 12));
        const sameRow = Math.max(0, ...Object.values(tops.reduce((o, t) => { o[t] = (o[t] || 0) + 1; return o; }, {})));
        if (sameRow > cols) cols = sameRow;
      }
      const heading = el.querySelector('h1, h2, h3');
      return {
        heading: heading ? heading.textContent.trim().replace(/\s+/g, ' ').slice(0, 90) : '',
        top: Math.round(r.top + scrollY), height: Math.round(r.height),
        background: toHex(cs(el).backgroundColor) || (cs(el).backgroundImage !== 'none' ? 'image/gradient' : null),
        columns: cols, images: el.querySelectorAll('img, picture, video').length,
        buttons: el.querySelectorAll('a[class*="btn" i], a[class*="button" i], button').length,
      };
    });
  })();

  const fontLinks = [...document.querySelectorAll('link[href*="fonts.googleapis"], link[href*="typekit"], link[href*="fonts.bunny"]')].map((l) => l.href);
  const meta = (n) => document.querySelector(`meta[name="${n}"], meta[property="${n}"]`)?.content || '';
  const container = (() => {
    const widths = all.filter(visible).map((el) => cs(el).maxWidth).filter((w) => /px$/.test(w) && parseFloat(w) >= 900 && parseFloat(w) <= 1600);
    const count = {};
    widths.forEach((w) => { count[w] = (count[w] || 0) + 1; });
    return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  })();

  return {
    url: location.href,
    title: document.title,
    description: meta('description') || meta('og:description'),
    ogImage: meta('og:image') ? abs(meta('og:image')) : '',
    themeColor: meta('theme-color'),
    favicon: abs(document.querySelector('link[rel*="apple-touch-icon"], link[rel~="icon"]')?.getAttribute('href') || '/favicon.ico'),
    colors: { pageBackground: bodyBg, backgrounds: top(bg, 8), text: top(text, 6) },
    cssVariables: cssVars,
    typography: { h1: typo(first('h1')), h2: typo(first('h2')), h3: typo(first('h3')), body: typo(first('main p, article p, section p, p')), nav: typo(first('nav a, header a')) },
    fontLinks,
    buttons,
    logo,
    logoClouds,
    sections,
    images,
    backgroundImages: bgImages,
    containerMaxWidth: container,
    nav: [...document.querySelectorAll('header a, nav a')].filter(visible).map((a) => a.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 14),
    headings: [...document.querySelectorAll('h1, h2, h3')].filter(visible).map((h) => `${h.tagName.toLowerCase()}: ${h.textContent.trim().replace(/\s+/g, ' ').slice(0, 120)}`).slice(0, 30),
    paragraphs: [...document.querySelectorAll('main p, section p, p')].filter(visible).map((p) => p.textContent.trim().replace(/\s+/g, ' ')).filter((t) => t.length > 40).slice(0, 10).map((t) => t.slice(0, 240)),
    pageHeight: document.documentElement.scrollHeight,
  };
}

// QA for a Blobby page at one viewport. Returns issues tied to element ids where possible.
export function qaProbe() {
  const issues = [];
  const W = window.innerWidth;
  const idOf = (el) => el && el.closest && el.closest('[data-b-id]')?.getAttribute('data-b-id');
  const label = (el) => {
    const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50);
    return `${el.tagName.toLowerCase()}${el.classList[0] ? '.' + el.classList[0] : ''}${t ? ` "${t}"` : ''}`;
  };
  const cs = (el) => getComputedStyle(el);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = cs(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
  };
  const add = (severity, rule, message, el) => issues.push({ severity, rule, message, element_id: el ? idOf(el) : undefined, element: el ? label(el) : undefined });
  const els = [...document.body.querySelectorAll('*')].filter((el) => !['SCRIPT', 'STYLE', 'BR'].includes(el.tagName));

  // Horizontal overflow: report the elements that actually stick out, not their containers.
  if (document.documentElement.scrollWidth > W + 1) {
    const clipped = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = cs(p).overflowX; if (o === 'hidden' || o === 'clip' || o === 'auto' || o === 'scroll') return true; } return false; };
    const out = els.filter((el) => { const r = el.getBoundingClientRect(); return visible(el) && (r.right > W + 1 || r.left < -1) && !clipped(el); });
    const leaves = out.filter((el) => !out.some((o) => o !== el && el.contains(o))).slice(0, 4);
    add('error', 'horizontal-overflow', `Page is ${document.documentElement.scrollWidth}px wide on a ${W}px screen (sideways scrolling).`, null);
    leaves.forEach((el) => { const r = el.getBoundingClientRect(); add('error', 'horizontal-overflow', `Sticks out of the screen (left ${Math.round(r.left)}px, right ${Math.round(r.right)}px).`, el); });
  }

  // Text contrast (WCAG AA) against the nearest solid background. Skips text on images/gradients.
  const parse = (c) => { const m = String(c).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/); return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null; };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => {
    for (let p = el; p; p = p.parentElement) {
      const s = cs(p);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      const c = parse(s.backgroundColor);
      if (c && c[3] > 0.9) return c;
    }
    return [255, 255, 255, 1];
  };
  let contrastCount = 0;
  for (const el of els) {
    if (contrastCount >= 8) break;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own || !visible(el)) continue;
    const s = cs(el);
    const fg = parse(s.color);
    const bg = bgOf(el);
    if (!fg || !bg || fg[3] < 0.5) continue;
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    const size = parseFloat(s.fontSize);
    const large = size >= 24 || (size >= 18.6 && Number(s.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    if (ratio < need) { add('error', 'contrast', `Text contrast ${ratio.toFixed(2)}:1 is below ${need}:1.`, el); contrastCount++; }
  }

  // Readability and touch.
  let small = 0;
  for (const el of els) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own && visible(el) && parseFloat(cs(el).fontSize) < 12 && small++ < 4) add('warning', 'tiny-text', `Font size ${cs(el).fontSize} is hard to read.`, el);
  }
  if (W <= 480) {
    let taps = 0;
    for (const el of document.querySelectorAll('a, button, input, select, textarea, [role=button]')) {
      if (!visible(el) || el.closest('p, li p')) continue;
      const r = el.getBoundingClientRect();
      if ((r.height < 40 || r.width < 40) && taps++ < 5) add('warning', 'tap-target', `Tap target is ${Math.round(r.width)}x${Math.round(r.height)}px (aim for 44px).`, el);
    }
  }

  // Content quality.
  for (const img of document.images) {
    if (img.complete && img.naturalWidth === 0) add('error', 'broken-image', `Image does not load: ${img.getAttribute('src')}`, img);
    else if (!img.hasAttribute('alt')) add('warning', 'missing-alt', 'Image has no alt text.', img);
  }
  const bodyText = document.body.innerText || '';
  if (/lorem ipsum|dolor sit amet/i.test(bodyText)) add('error', 'placeholder-copy', 'Page still contains lorem ipsum. Write real copy for this site.', null);
  if (/\b(TODO|TBD|XXX|\[insert|placeholder text)\b/i.test(bodyText)) add('warning', 'placeholder-copy', 'Page contains placeholder text (TODO/TBD/[insert…]).', null);
  const h1s = [...document.querySelectorAll('h1')].filter(visible);
  if (h1s.length !== 1) add('warning', 'headings', `Page has ${h1s.length} visible h1 elements (use exactly one).`, h1s[1] || null);
  for (const el of els) {
    if (!visible(el)) continue;
    const s = cs(el);
    if ((s.overflow === 'hidden' || s.overflowX === 'hidden') && el.scrollWidth > el.clientWidth + 2 && el.innerText && el.innerText.trim()) {
      add('warning', 'clipped-content', 'Content is cut off inside this element.', el);
    }
  }
  for (const sec of document.querySelectorAll('body > *, section')) {
    if (sec.tagName !== 'SCRIPT' && sec.tagName !== 'STYLE' && sec.getBoundingClientRect().height < 4 && sec.children.length) add('warning', 'collapsed', 'Element has content but is collapsed to ~0px tall.', sec);
  }
  // Empty image boxes: grey/flat blocks standing in for a photo.
  const hint = /(^|[-_\s])(img|image|photo|picture|media|thumb|avatar|placeholder|visual|art|hero-img|cover)([-_\s]|$)/i;
  let empties = 0;
  for (const el of els) {
    if (empties >= 6 || el.closest('svg') || !visible(el) || el.children.length || (el.textContent || '').trim()) continue;
    if (['IMG', 'SVG', 'VIDEO', 'CANVAS', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT', 'HR', 'PICTURE'].includes(el.tagName.toUpperCase())) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 90 || r.width > W * 0.98) continue;
    const s = cs(el);
    if (s.backgroundImage !== 'none' && !/gradient/.test(s.backgroundImage)) continue;
    const c = parse(s.backgroundColor);
    const grey = c && c[3] > 0.3 && Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) < 18;
    const named = hint.test(el.getAttribute('class') || '') || /image|photo/i.test(el.getAttribute('aria-label') || '');
    if (named || (grey && s.borderStyle === 'dashed')) { add(/gradient/.test(s.backgroundImage) ? 'warning' : 'error', 'image-placeholder', 'Empty box where an image should be. Use a real photo (analyze_site / analyze_social / find_images / add_asset), or design this block as real art. Never ship grey boxes.', el); empties++; }
    else if (grey && r.width * r.height > 40000) { add('warning', 'image-placeholder', 'Large flat grey box with no content. If it stands in for an image, use a real one.', el); empties++; }
  }

  // Logo strips written as plain text names.
  for (const row of document.querySelectorAll('ul, ol, div, section')) {
    const items = [...row.children].filter(visible);
    if (items.length < 4 || items.length > 14) continue;
    const textOnly = items.every((k) => !k.querySelector('img, svg, picture') && /^\S+(\s\S+){0,2}$/.test((k.textContent || '').trim()));
    if (!textOnly) continue;
    const ctx = `${row.className} ${row.getAttribute('aria-label') || ''} ${row.closest('section')?.querySelector('h2, h3, p')?.textContent || ''} ${row.previousElementSibling?.textContent || ''}`;
    if (/logo|trusted|clients?|customers?|partners?|brands|used by|featured|as seen/i.test(ctx)) {
      add('error', 'text-logos', 'Logo strip shows company names as text. Use real logos: find_logos, or the logoClouds from analyze_site.', row);
      break;
    }
  }
  return { viewport: W, pageHeight: document.documentElement.scrollHeight, issues: issues.slice(0, 40) };
}

// Reads what a public profile page shows to a logged-out visitor (Instagram, X, YouTube, LinkedIn,
// TikTok, Linktree, Behance, …): name, bio, links, structured data and the visible photos.
export function profileProbe() {
  const meta = (n) => document.querySelector(`meta[name="${n}"], meta[property="${n}"]`)?.content || '';
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const seen = new Set();
  const images = [...document.images]
    .filter((i) => visible(i) && i.naturalWidth >= 150 && i.naturalHeight >= 150)
    .map((i) => ({ src: abs(i.currentSrc || i.src), alt: (i.alt || '').slice(0, 220), width: i.naturalWidth, height: i.naturalHeight }))
    .filter((i) => !seen.has(i.src) && seen.add(i.src))
    .slice(0, 30);
  const host = location.hostname.replace(/^www\./, '');
  const links = [...new Set([...document.querySelectorAll('a[href^="http"]')].map((a) => a.href)
    .filter((h) => { try { return !new URL(h).hostname.endsWith(host); } catch { return false; } }))].slice(0, 15);
  const structured = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent.trim()).join('\n').slice(0, 3000);
  const text = (document.body.innerText || '').replace(/\n{2,}/g, '\n').trim();
  return {
    url: location.href,
    title: document.title,
    name: meta('og:title') || meta('twitter:title'),
    description: meta('og:description') || meta('description') || meta('twitter:description'),
    profileImage: abs(meta('og:image') || meta('twitter:image') || ''),
    siteName: meta('og:site_name'),
    structured,
    links,
    images,
    text: text.slice(0, 1500),
    loginWall: images.length < 3 && /log ?in|sign ?up|sign in/i.test(text.slice(0, 2000)),
  };
}
