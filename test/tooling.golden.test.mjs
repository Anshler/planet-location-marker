// Unit tests for the visual-regression tooling: scripts/lib/golden.mjs (comparison, usability,
// the text-mode structure and its diff), the scene matrix in scripts/golden.mjs, and the CI wiring
// that pins Chrome and runs the gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    compareImages, goldenUsable, domSummary, diffLines, luma, LUMA_THRESHOLD, MAX_CHANGED_FRACTION,
} from '../scripts/lib/golden.mjs';
import { GOLDEN_SCENES } from '../scripts/golden.mjs';
import { DEFAULT_LAYER_CODE } from '../js/core/url-state.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A w×h grey image (value v) with `channels` channels. */
function image(w, h, v = 40, channels = 3) {
    const data = new Uint8Array(w * h * channels).fill(v);
    if (channels === 4) for (let i = 3; i < data.length; i += 4) data[i] = 255;
    return { width: w, height: h, channels, data };
}
const setPx = (img, i, v) => { img.data.fill(v, i * img.channels, i * img.channels + 3); };

test('golden compare: identical images match, the heat map is the dimmed golden', () => {
    const a = image(20, 10, 80), b = image(20, 10, 80);
    const r = compareImages(a, b);
    assert.equal(r.ok, true);
    assert.equal(r.changed, 0);
    assert.equal(r.maxDelta, 0);
    assert.equal(r.heat.length, 20 * 10 * 3);
    assert.equal(r.heat[0], Math.round(luma(80, 80, 80) * 0.25));
});

test('golden compare: a pixel counts when its luma moves by more than the threshold', () => {
    assert.equal(LUMA_THRESHOLD, 6);
    const a = image(10, 10, 100);
    const b = image(10, 10, 100);
    setPx(b, 0, 100 + LUMA_THRESHOLD);        // exactly the threshold: unchanged
    setPx(b, 1, 100 + LUMA_THRESHOLD + 1);    // just over: changed
    setPx(b, 2, 100 - 60);                    // far: changed, yellow end of the ramp
    const r = compareImages(a, b, { maxFraction: 1 });
    assert.equal(r.changed, 2);
    assert.equal(r.maxDelta, 60);
    assert.deepEqual([...r.heat.subarray(3, 6)], [255, 48 + Math.round(207 * (1 / 32)), 0]);
    assert.deepEqual([...r.heat.subarray(6, 9)], [255, 255, 0]);
    // Green weighs most in luma: a pure-blue change of 20 levels stays under the threshold.
    const c = image(10, 10, 100);
    c.data[2] = 120;
    assert.equal(compareImages(a, c).changed, 0);
});

test('golden compare: fails above 0.5 % of the pixels; sizes must match; alpha is ignored', () => {
    assert.equal(MAX_CHANGED_FRACTION, 0.005);
    const a = image(100, 100, 50);
    const b = image(100, 100, 50);
    for (let i = 0; i < 50; i++) setPx(b, i, 200);        // 0.50 %: still fine
    assert.equal(compareImages(a, b).ok, true);
    setPx(b, 50, 200);                                     // 0.51 %
    const r = compareImages(a, b);
    assert.equal(r.ok, false);
    assert.match(r.reason, /0\.51 % of pixels changed \(max 0\.50 %\)/);
    const size = compareImages(a, image(100, 99, 50));
    assert.equal(size.ok, false);
    assert.match(size.reason, /size 100×99, golden 100×100/);
    const rgba = image(100, 100, 50, 4);
    rgba.data[3] = 0;                                      // alpha differs: not a change
    assert.equal(compareImages(a, rgba).changed, 0);
    assert.equal(compareImages(a, b, { heat: false }).heat, null);
    assert.throws(() => compareImages(image(2, 2, 0, 1), image(2, 2, 0, 1)), RangeError);
});

test('golden usability: skips without goldens, or for another Chrome, platform or renderer', () => {
    const meta = { chrome: '153.0.8010.12', platform: 'linux-x64', renderer: 'SwiftShader', scenes: {} };
    const env = { chrome: '153.0.8010.12', platform: 'linux-x64', renderer: 'SwiftShader' };
    assert.deepEqual(goldenUsable(meta, env), { usable: true, reason: null });
    assert.deepEqual(goldenUsable(meta, { ...env, renderer: null }), { usable: true, reason: null }, 'renderer not known yet');
    assert.match(goldenUsable(null, env).reason, /no goldens/);
    assert.match(goldenUsable({ chrome: 'x' }, env).reason, /no goldens/, 'a meta without scenes');
    assert.match(goldenUsable(meta, { ...env, chrome: '154.0.1.2' }).reason, /made with Chrome 153\.0\.8010\.12, this is 154\.0\.1\.2/);
    assert.match(goldenUsable(meta, { ...env, platform: 'win32-x64' }).reason, /made on linux-x64, this is win32-x64/);
    assert.match(goldenUsable(meta, { ...env, renderer: 'ANGLE (NVIDIA)' }).reason, /renderer/);
});

test('golden structure: line diff marks what only the golden (-) or only this run (+) has', () => {
    assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'b', 'c']), []);
    assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'c']), ['- b']);
    assert.deepEqual(diffLines(['a', 'c'], ['a', 'b', 'c']), ['+ b']);
    assert.deepEqual(diffLines(['a', 'b'], ['a', 'x']), ['+ x', '- b']);
    assert.deepEqual(diffLines([], ['a', 'b']), ['+ a', '+ b']);
    assert.equal(diffLines([], Array.from({ length: 50 }, (_, i) => String(i)), 5).length, 5);
});

test('golden structure: domSummary lists marked elements, masks digits, skips hidden subtrees', () => {
    const el = (tag, attrs = {}, kids = [], visible = true) => ({
        tagName: tag.toUpperCase(), id: attrs.id ?? '', children: kids,
        getAttribute: (k) => attrs[k] ?? null, checkVisibility: () => visible,
    });
    const body = el('body', {}, [
        el('div', { id: 'ui-root' }, [
            el('div', {}, [el('button', { 'aria-label': 'Step back 1 hour' })]),     // unmarked wrapper: no depth
            el('div', { role: 'dialog', 'aria-label': 'Share' }, [el('button', { 'aria-label': 'Close' })], false),
            el('script', { id: 'x' }),
        ]),
    ]);
    const lines = new Function('document', `return (${domSummary})();`)({ body });
    assert.deepEqual(lines, [
        'div#ui-root',
        '  button "Step back # hour"',
        '  div[role=dialog] "Share" (hidden)',
    ]);
});

test('golden scenes: unique file-safe names, paused, no intro, no labels or satellites, both tiers, a phone and text mode', () => {
    const names = GOLDEN_SCENES.map((s) => s.name);
    assert.equal(new Set(names).size, names.length);
    for (const s of GOLDEN_SCENES) {
        assert.match(s.name, /^[a-z0-9-]+$/);
        assert.match(s.url, /^\/#/);
        for (const k of ['p=0', 'intro=0']) assert.ok(s.url.includes(k), `${s.name}: ${k}`);
        if (s.text) continue;
        const ly = new URLSearchParams(s.url.slice(2)).get('ly');
        assert.ok(ly, `${s.name}: explicit layers`);
        assert.ok(!ly.includes('l') && !ly.includes('i'), `${s.name}: labels and satellites off`);
        assert.equal(ly, DEFAULT_LAYER_CODE.replace('l', '').replace('i', ''), 'the defaults otherwise');
        assert.match(s.url, /[#&]q=(low|medium|high)(&|$)/, `${s.name}: an explicit tier (SwiftShader would pick low)`);
    }
    const has = (f) => GOLDEN_SCENES.some(f);
    assert.ok(has((s) => /q=low/.test(s.url)) && has((s) => /q=high/.test(s.url)));
    assert.ok(has((s) => s.mobile) && has((s) => s.text));
    assert.ok(has((s) => /view=sky/.test(s.url)) && has((s) => /2027-08-02/.test(s.url)));
});

test('CI: one pinned Chrome for every browser step, the perf gates, the golden step and the goldens job', () => {
    const ci = fs.readFileSync(`${ROOT}/.github/workflows/ci.yml`, 'utf8');
    const version = ci.match(/CHROME_VERSION: '(\d+\.\d+\.\d+\.\d+)'/)?.[1];
    assert.ok(version, 'an exact Chrome for Testing version');
    assert.equal((ci.match(/uses: browser-actions\/setup-chrome@v\d+/g) ?? []).length, 2, 'the test job and the goldens job');
    assert.equal((ci.match(/chrome-version: \$\{\{ env\.CHROME_VERSION \}\}/g) ?? []).length, 2);
    assert.ok(!/which google-chrome/.test(ci), 'no runner-provided Chrome');
    assert.match(ci, /smoke\.mjs --offline --perf=low --context-loss/);
    assert.match(ci, /smoke\.mjs --offline --perf=high --context-loss --width=320 --height=240/);
    assert.match(ci, /run: node scripts\/golden\.mjs --out=golden-out/);
    assert.match(ci, /golden\.mjs --update --out=golden-out/);
    assert.match(ci, /if: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.render_goldens \}\}/);
    assert.match(ci, /name: goldens\n\s+path: test\/golden\//);
    // Committed goldens, if any, say what made them (another Chrome is a skip in CI, not a failure).
    const metaFile = `${ROOT}/test/golden/meta.json`;
    if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        assert.ok(meta.chrome && meta.platform && meta.scenes, 'test/golden/meta.json: chrome, platform, scenes');
        for (const [name, s] of Object.entries(meta.scenes)) assert.ok(fs.existsSync(`${ROOT}/test/golden/${s.file}`), name);
    }
});
