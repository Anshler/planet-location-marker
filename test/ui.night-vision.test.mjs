// Night vision (ROADMAP night-vision-mode): the CSS filter chain really is dim pure red, the early
// script in index.html, and Shift+N reaching the toggle before plain N's 'Live'.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const css = fs.readFileSync(new URL('css/app.css', ROOT), 'utf8');
const html = fs.readFileSync(new URL('index.html', ROOT), 'utf8');

// Filter Effects Module Level 1, §13.2: the shorthand functions as feColorMatrix matrices on sRGB
// values, each result clamped to [0, 1] before the next function.
const D = Math.PI / 180;
const MATRIX = {
    grayscale: (a) => { const k = 1 - Math.min(1, a); return [
        [0.2126 + 0.7874 * k, 0.7152 - 0.7152 * k, 0.0722 - 0.0722 * k],
        [0.2126 - 0.2126 * k, 0.7152 + 0.2848 * k, 0.0722 - 0.0722 * k],
        [0.2126 - 0.2126 * k, 0.7152 - 0.7152 * k, 0.0722 + 0.9278 * k]]; },
    sepia: (a) => { const k = 1 - Math.min(1, a); return [
        [0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k],
        [0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k],
        [0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k]]; },
    saturate: (s) => [
        [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
        [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
        [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s]],
    'hue-rotate': (deg) => { const c = Math.cos(deg * D), s = Math.sin(deg * D); return [
        [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
        [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
        [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072]]; },
    brightness: (b) => [[b, 0, 0], [0, b, 0], [0, 0, b]],
};

/** The `html.is-red` filter as [name, amount] steps. */
function redChain() {
    const m = css.match(/html\.is-red\s*\{\s*filter:\s*([^;]+);/);
    assert.ok(m, 'html.is-red has a filter');
    assert.doesNotMatch(m[1], /url\(/, 'no SVG reference filter (it leaves the GPU fast path)');
    assert.ok(m[1].trim().split(/\)\s+/).length <= 4, 'a short chain: each function costs a pass in software compositing');
    return [...m[1].matchAll(/([a-z-]+)\(\s*([-\d.]+)(deg|%)?\s*\)/g)].map(([, f, v, u]) => {
        assert.ok(MATRIX[f], `a colour-matrix function: ${f}`);
        return [f, u === '%' ? Number(v) / 100 : Number(v)];
    });
}

function apply(chain, rgb) {
    let v = rgb.map((x) => x / 255);
    for (const [f, a] of chain) {
        const M = MATRIX[f](a);
        v = M.map((r) => Math.min(1, Math.max(0, r[0] * v[0] + r[1] * v[1] + r[2] * v[2])));
    }
    return v;
}
/** sepia(1)'s own luminance: its rows are nearly proportional to (.272, .534, .131). */
const luma = ([r, g, b]) => (0.272 * r + 0.534 * g + 0.131 * b) / 0.937;

test('night vision: the filter is pure red, by luminance, without clipping', () => {
    const chain = redChain();
    const colours = [
        [255, 255, 255], [232, 237, 246], [154, 166, 184], [127, 139, 159], [124, 196, 255], [255, 211, 107],
        [255, 106, 61], [79, 134, 198], [0, 255, 0], [0, 0, 255], [255, 0, 0], [128, 128, 128], [10, 14, 23], [0, 0, 0],
    ];
    const white = apply(chain, [255, 255, 255])[0];
    assert.ok(white > 0.5 && white < 0.75, `white is dim: ${white.toFixed(3)}`);
    for (const c of colours) {
        const [r, g, b] = apply(chain, c);
        assert.ok(g < 0.5 / 255 && b < 0.5 / 255, `${c}: no green or blue (${g}, ${b})`);
        // Red follows the luminance (within 1 %: sepia’s rows are only nearly proportional), nothing clipped.
        assert.ok(Math.abs(r - white * luma(c) / 255) < 0.01, `${c}: ${r.toFixed(4)} vs ${(white * luma(c) / 255).toFixed(4)}`);
    }
});

test('night vision: index.html applies the saved setting before the first paint', () => {
    const head = html.slice(0, html.indexOf('</head>'));
    assert.match(head, /localStorage\.getItem\('pc2\.display'\)/);
    assert.match(head, /classList\.add\('is-red'\)/);
    // Before the stylesheet's first paint, and before any module (the import map stays first among those).
    assert.ok(head.indexOf("classList.add('is-red')") < head.indexOf('<link rel="stylesheet"'));
});

test('night vision: Shift+N toggles it; plain N still goes live', async () => {
    let handler = null;
    globalThis.window = { addEventListener: (n, fn) => { handler = fn; }, removeEventListener: () => { handler = null; } };
    globalThis.Element ??= class {};
    try {
        const { bindShortcuts } = await import('../js/ui/shortcuts.js');
        const calls = [];
        const flashes = [];
        let red = false;
        const store = { get: () => ({ ui: {}, view: {}, layers: {}, display: { red } }) };
        const clock = { goLive: () => calls.push('live') };
        const ui = { flash: (t) => flashes.push(t), act: (name) => { calls.push(name); if (name === 'setNightVision') red = !red; return red; } };
        const off = bindShortcuts({ store, clock, ui });
        const key = (o) => handler({ key: 'N', code: 'KeyN', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, target: null, preventDefault() {}, ...o });
        key({ shiftKey: true });
        key({ shiftKey: true });
        key({});
        assert.deepEqual(calls, ['setNightVision', 'setNightVision', 'live']);
        assert.deepEqual(flashes, ['Night vision on', 'Night vision off', 'Live']);
        off();
    } finally {
        delete globalThis.window;
    }
});

test('night vision: the help table lists Shift+N', async () => {
    const { SHORTCUTS } = await import('../js/ui/help.js');
    const rows = SHORTCUTS.flatMap((g) => g.rows);
    assert.ok(rows.some(([k, d]) => k === 'Shift+N' && /night vision/i.test(d)));
    // No other row claims the same keys.
    const keys = rows.flatMap(([k]) => k.split('|'));
    assert.equal(keys.filter((k) => k === 'Shift+N').length, 1);
});
