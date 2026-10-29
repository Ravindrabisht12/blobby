// Editor-only rendering tweaks. The page files on disk are never changed by this.
//
// Artboards and screenshots render at full content height, so `100vh` would otherwise
// grow with the frame forever. We rewrite vh units to a fixed device viewport height.

const VH_RE = /(-?\d*\.?\d+)(?:d|s|l)?vh\b/g;

export function rewriteVh(html, viewportHeight) {
  const unit = `${(viewportHeight / 100).toFixed(3)}px`;
  const fix = (css) => css.replace(VH_RE, (_, n) => `calc(${n} * var(--blobby-vh, ${unit}))`);
  return html
    .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, a, css, b) => a + fix(css) + b)
    .replace(/style="([^"]*)"/gi, (_, css) => `style="${fix(css)}"`)
    .replace(/<head>/i, `<head><style id="blobby-vh">:root{--blobby-vh:${unit}}</style>`);
}

export const DEVICES = {
  desktop: { label: 'Desktop', width: 1440, height: 900 },
  tablet: { label: 'Tablet', width: 768, height: 1024 },
  mobile: { label: 'Mobile', width: 390, height: 844 },
};
