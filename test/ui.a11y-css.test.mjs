// Accessibility in css/app.css: contrast of the secondary text over the glass panels (also over a
// pale daytime sky), and the system preferences: reduced transparency, more contrast, forced colours.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../css/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first block whose prelude matches `re` (brace-matched). */
function block(re) {
    const m = re.exec(css);
    assert.ok(m, `found ${re}`);
    let i = css.indexOf('{', m.index) + 1;
    const start = i;
    for (let depth = 1; depth; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0;
    return css.slice(start, i - 1);
}
/** Custom properties declared in a block body (the last one wins). */
function vars(body) {
    return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
}
function rgba(v) {
    const hex = /^#([0-9a-f]{6})$/i.exec(v);
    if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
    const m = /^rgba?\(([^)]+)\)$/.exec(v);
    assert.ok(m, `a colour: ${v}`);
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
}
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** A translucent panel over a backdrop, with the glass's 3.5 % white sheen on top. */
const over = (panel, backdrop) => panel.slice(0, 3).map((c, i) => c * panel[3] + backdrop[i] * (1 - panel[3])).map((c) => c + 0.035 * (255 - c));

const root = vars(block(/:root\s*\{/));
const sky = vars(block(/body\.is-sky\s*\{/));
const WHITE = [255, 255, 255];

test('secondary text keeps 4.5:1 on the solid panel, and in sky view even over white cloud', () => {
    const solid = over(rgba(root['--panel-solid']), WHITE);
    assert.ok(contrast(rgba(root['--muted']), solid) >= 4.5, 'muted on the solid panel');
    // The see-through glass of the blur tiers, in sky view (a pale daytime sky behind it).
    const glass = over(rgba(sky['--panel']), WHITE);
    assert.ok(contrast(rgba(root['--muted']), glass) >= 4.5, `muted over white: ${contrast(rgba(root['--muted']), glass).toFixed(2)}`);
    assert.ok(contrast(rgba(sky['--faint']), glass) >= 4.5, `faint over white: ${contrast(rgba(sky['--faint']), glass).toFixed(2)}`);
});

test('focus rings carry a dark halo, so they show over a pale sky', () => {
    const ring = block(/\.ui :focus-visible\s*\{/);
    assert.match(ring, /outline:\s*2px solid var\(--accent\)/);
    assert.match(ring, /box-shadow:\s*0 0 0 \d+px rgba\(3, 6, 13/);
});

test('prefers-reduced-transparency: opaque panels, no backdrop blur', () => {
    const body = block(/@media \(prefers-reduced-transparency: reduce\)/);
    const v = vars(body);
    for (const k of ['--panel', '--panel-solid', '--surface']) assert.equal(rgba(v[k])[3], 1, `${k} opaque`);
    assert.match(body, /:root, body\.is-sky/, 'the sky view gives way too');
    assert.match(body, /\.glass[^{]*\{[^}]*backdrop-filter:\s*none !important/);
});

test('prefers-contrast: more brightens the secondary text and edges the panels and chips', () => {
    const body = block(/@media \(prefers-contrast: more\)/);
    const v = vars(body);
    const panel = rgba(v['--panel-solid']);
    assert.equal(panel[3], 1);
    assert.ok(contrast(rgba(v['--muted']), panel) >= 7, 'muted reaches AAA');
    assert.ok(contrast(rgba(v['--faint']), panel) >= 7, 'faint reaches AAA');
    assert.ok(lum(rgba(v['--muted'])) > lum(rgba(root['--muted'])));
    assert.match(body, /\.glass, \.chip, \.bchip, \.seg[^{]*\{\s*border: 1px solid var\(--line-2\)/);
});

test('forced-colors: system-colour edges and states on panels, chips, segments, switches and the thumb', () => {
    const body = block(/@media \(forced-colors: active\)/);
    assert.match(body, /\.glass[^{]*\{[^}]*border: 1px solid CanvasText/);
    assert.match(body, /\.chip, \.bchip, \.echip, \.btn, \.seg[^{]*\{\s*border: 1px solid ButtonText/);
    assert.match(body, /\.switch-row\[aria-checked="true"\] \.switch \{[^}]*Highlight/);
    assert.match(body, /\.seg \.seg__btn\[aria-checked="true"\][^{]*\{[^}]*background: Highlight/);
    assert.match(body, /\.tb-scrub__knob \{[^}]*Highlight/);
    assert.match(body, /:focus-visible[^{]*\{[^}]*outline: 2px solid Highlight/);
    // Every colour named in the block is a system colour (or the canvases' own dark ground).
    const named = [...body.matchAll(/:\s*[^;{}]*?\b([A-Z][a-zA-Z]+)\b/g)].map((m) => m[1]);
    for (const c of named) assert.ok(['Canvas', 'CanvasText', 'ButtonText', 'Highlight', 'HighlightText'].includes(c), c);
});
