#!/usr/bin/env node
// Visual-regression goldens: renders a fixed matrix of scenes in headless Chrome (SwiftShader) and
// compares each WebGL canvas, the interface hidden, with test/golden/<scene>.png.
//
//   node scripts/golden.mjs                 compare (CI); skips with a notice when unusable
//   node scripts/golden.mjs --update        render every scene and rewrite test/golden/
//
//   --only=a,b      just these scenes (--list prints them)
//   --dir=path      goldens directory (default test/golden)
//   --out=path      this run's renders, diff heat maps and report.json (default golden-out/)
//   --browser=path  browser executable (default: $CHROME_PATH, then the usual install locations)
//
// Every scene is paused (p=0), skips the intro, runs with reduced motion (no twinkle) and has the
// labels and satellites layers off: labels are DOM text, so which planet medallions show depends
// on the machine's fonts, and the satellites' elements (data/tle.json) are refreshed. The page
// settles first (textures in, no request for 2 s, supersampling history full, no frame drawn),
// then the DOM is hidden and the canvas captured at its own resolution. Text mode (no WebGL) has
// no canvas: its golden is the page's structure (scripts/lib/golden.mjs domSummary).
//
// A golden only means something for the Chrome build and renderer that made it: meta.json records
// the Chrome version, platform and WebGL renderer, and a run with any other one skips (exit 0)
// with a notice. CI pins Chrome (.github/workflows/ci.yml) and makes the goldens itself: run the
// CI workflow by hand with 'Render goldens' ticked, download the 'goldens' artifact into
// test/golden/ and commit it. Exit codes: 0 match or skip · 1 a scene differs · 2 infrastructure.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from './lib/http.mjs';
import { findChrome, launchChrome, CdpClient } from './lib/chrome.mjs';
import { decodePng, encodePng } from './lib/png.mjs';
import { compareImages, goldenUsable, domSummary, diffLines, LUMA_THRESHOLD, MAX_CHANGED_FRACTION } from './lib/golden.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The default layers (url-state DEFAULT_LAYER_CODE) without labels (l) and satellites (i). */
const LAYERS = 'bgoscCnmkazhdxw';
const HCMC = 'loc=10.8231,106.6297&n=Ho%20Chi%20Minh%20City&tz=Asia/Ho_Chi_Minh&t=2026-11-04T15:00:00Z';
// 2 Aug 2027: greatest totality at Luxor 10:05:08 UT, the Sun 82° up at azimuth 196°.
const LUXOR = 'loc=25.6872,32.6396&n=Luxor&tz=Africa/Cairo&t=2027-08-02T10:05:08Z';
// Midsummer in Paris: sunset 19:58 UT; ten minutes before, the Sun is 1° up at azimuth 306°.
const PARIS = 'loc=48.8566,2.3522&n=Paris&tz=Europe/Paris&t=2026-06-21T19:48:00Z';
const SCENE = `p=0&intro=0&ly=${LAYERS}`;

/**
 * The matrix. `mobile`: 390×844 @3, touch (a coarse pointer: the phone's Medium), captured at the
 * canvas's own resolution (585×1266 at its DPR of 1.5), so anti-aliasing changes show; otherwise
 * 1440×900 @1, captured at half size (720×450: content, colour and layout regressions, at a
 * quarter of the bytes in the repository). `text`: WebGL disabled, the structure is compared.
 */
export const GOLDEN_SCENES = Object.freeze([
    { name: 'globe-hcmc-night-high', url: `/#${HCMC}&${SCENE}&q=high` },
    { name: 'globe-hcmc-night-low', url: `/#${HCMC}&${SCENE}&q=low` },
    { name: 'eclipse-luxor-globe-high', url: `/#${LUXOR}&${SCENE}&q=high` },
    { name: 'eclipse-luxor-sky-high', url: `/#${LUXOR}&${SCENE}&view=sky&cam=s:196,72,60&q=high` },
    { name: 'sunset-paris-sky-high', url: `/#${PARIS}&${SCENE}&view=sky&cam=s:300,8,70&q=high` },
    { name: 'mobile-globe-hcmc-medium', url: `/#${HCMC}&${SCENE}&q=medium`, mobile: true, scale: 1 },
    { name: 'mobile-eclipse-luxor-sky-medium', url: `/#${LUXOR}&${SCENE}&view=sky&cam=s:196,72,60&q=medium`, mobile: true, scale: 1 },
    { name: 'text-mode', url: `/#${HCMC}&p=0&intro=0`, text: true },
].map((s) => Object.freeze(s)));

/**
 * Runs in the page: waits until nothing changes any more (no frame, no request, textures in,
 * supersampling done, no camera tween) for `quietMs`, then reports what the capture needs.
 */
async function settlePage({ quietMs, maxMs, dom }) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const A = window.__app, R = A && A.internals;
    const rc = R && R.rc && R.rc.renderer ? R.rc : null;
    const t0 = performance.now();
    let since = t0, last = '', settled = false;
    while (performance.now() - t0 < maxMs) {
        await sleep(200);
        const p = R && R.textures && R.textures.progress ? R.textures.progress() : { loaded: 0, total: 0 };
        const ss = R && R.loop && R.loop.supersample;
        const busy = p.loaded < p.total || (ss && ss.cap > 1 && ss.samples < ss.cap) || (R && R.rig && R.rig.tweening)
            || A.store.get().status.introPlaying;
        const key = `${rc ? A.stats().frames : 0}|${performance.getEntriesByType('resource').length}|${busy}|${dom ? window.__goldenDom : 0}`;
        if (key !== last || busy) { last = key; since = performance.now(); } else if (performance.now() - since >= quietMs) { settled = true; break; }
    }
    let renderer = null;
    if (rc) {
        const gl = rc.renderer.getContext();
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    }
    return { settled, waitedMs: Math.round(performance.now() - t0), renderer, frames: rc ? A.stats().frames : 0, tier: A.tier,
        rcDpr: rc ? rc.dpr || 1 : 1, dpr: window.devicePixelRatio || 1, w: window.innerWidth, h: window.innerHeight };
}

const HIDE_DOM = `(() => {
    const st = document.createElement('style');
    st.textContent = 'body > :not(#scene) { visibility: hidden !important; } #scene { visibility: visible !important; }';
    document.head.append(st);
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(window.__app.stats().frames))));
})()`;

function parseArgs(argv) {
    const a = Object.fromEntries(argv.map((s) => {
        const m = s.match(/^--([^=]+)(?:=(.*))?$/s);
        return m ? [m[1], m[2] ?? 'true'] : [s, 'true'];
    }));
    const known = new Set(['update', 'only', 'dir', 'out', 'browser', 'list', 'help']);
    for (const k of Object.keys(a)) if (!known.has(k)) console.warn(`golden: unknown option --${k} (ignored)`);
    const only = (a.only ?? '').split(',').map((s) => s.trim()).filter((s) => s && s !== 'true');
    return {
        update: a.update !== undefined && a.update !== 'false', list: a.list !== undefined, help: a.help !== undefined, only,
        dir: path.resolve(ROOT, a.dir && a.dir !== 'true' ? a.dir : 'test/golden'),
        out: path.resolve(ROOT, a.out && a.out !== 'true' ? a.out : 'golden-out'),
        browser: a.browser && a.browser !== 'true' ? a.browser : null,
    };
}

const GH = process.env.GITHUB_ACTIONS === 'true';
const annotate = (level, title, msg) => { if (GH) console.log(`::${level} title=${title}::${msg.replace(/\r?\n/g, '%0A')}`); };
const summary = (md) => { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`); };

/** Opens one scene in a fresh browser (a clean profile: no prefs carried over) and captures it. */
async function renderScene(scene, base, exe) {
    const vp = scene.mobile ? { width: 390, height: 844, dpr: 3 } : { width: 1440, height: 900, dpr: 1 };
    const chrome = await launchChrome({
        executable: exe, width: vp.width, height: vp.height, hostRules: 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        extraArgs: ['--enable-automation', ...(scene.text ? ['--disable-3d-apis', '--disable-webgl', '--disable-webgl2'] : [])],
    });
    let cdp = null;
    const errors = [];
    try {
        cdp = await CdpClient.connect(chrome.wsUrl);
        const { product, userAgent } = await cdp.send('Browser.getVersion');
        const { targetInfos } = await cdp.send('Target.getTargets');
        let targetId = targetInfos.find((t) => t.type === 'page')?.targetId;
        if (!targetId) ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        const page = (m, p) => cdp.send(m, p, sessionId);
        cdp.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text));
        cdp.on('Runtime.consoleAPICalled', (p) => {
            if (p.type === 'error') errors.push(p.args.map((x) => x.value ?? x.description ?? '').join(' '));
        });
        await page('Page.enable');
        await page('Runtime.enable');
        await page('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: !!scene.mobile });
        if (scene.mobile) {
            const major = userAgent.match(/Chrome\/(\d+)/)?.[1] ?? '130';
            await page('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
            await page('Emulation.setUserAgentOverride', {
                userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
                platform: 'Android',
            });
        }
        await page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        await page('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
        // Requests and (text mode) elements added or removed are part of "still changing".
        await page('Page.addScriptToEvaluateOnNewDocument', { source: `performance.setResourceTimingBufferSize(10000);
            window.__goldenDom = 0;
            new MutationObserver((l) => { for (const r of l) if (r.type === 'childList') window.__goldenDom++; })
                .observe(document, { childList: true, subtree: true });` });
        const evaluate = async (expression) => {
            const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
            return r.result.value;
        };
        await page('Page.navigate', { url: new URL(scene.url.replace(/^\/+/, ''), base).href });
        const t0 = Date.now();
        while (!(await evaluate('window.__app?.ready === true').catch(() => false))) {
            if (Date.now() - t0 > 60000) throw new Error('not ready after 60 s');
            await sleep(250);
        }
        const chromeVersion = product.match(/\/([\d.]+)/)?.[1] ?? product;
        const opts = JSON.stringify({ quietMs: 2000, maxMs: 180000, dom: !!scene.text });
        let st = await evaluate(`(${settlePage})(${opts})`);
        if (scene.text) {
            const lines = await evaluate(`(${domSummary})()`);
            return { chrome: chromeVersion, settle: st, lines, errors };
        }
        // Hiding the DOM must not draw a frame (one would restart the supersampling history).
        for (let k = 0; k < 3; k++) {
            const after = await evaluate(HIDE_DOM);
            if (after === st.frames) break;
            st = await evaluate(`(${settlePage})(${opts})`);
        }
        // The canvas's own pixels (its DPR over the device's), times the scene's capture scale.
        const scale = Math.round(((scene.scale ?? 0.5) * st.rcDpr / st.dpr) * 1e6) / 1e6;
        const shot = await page('Page.captureScreenshot', { format: 'png', fromSurface: true,
            clip: { x: 0, y: 0, width: st.w, height: st.h, scale } });
        return { chrome: chromeVersion, settle: st, png: Buffer.from(shot.data, 'base64'), errors };
    } finally {
        try { if (cdp) { await Promise.race([cdp.send('Browser.close').catch(() => {}), sleep(2000)]); cdp.close(); } } catch { /* gone */ }
        await chrome.kill();
    }
}

/** The browser's version ('153.0.8010.12'), from a launch that opens no page. */
async function browserVersion(exe) {
    const chrome = await launchChrome({ executable: exe, width: 800, height: 600 });
    try {
        const cdp = await CdpClient.connect(chrome.wsUrl);
        const { product } = await cdp.send('Browser.getVersion');
        await Promise.race([cdp.send('Browser.close').catch(() => {}), sleep(2000)]);
        cdp.close();
        return product.match(/\/([\d.]+)/)?.[1] ?? product;
    } finally {
        await chrome.kill();
    }
}

/** RGB, re-encoded at the encoder's best: the goldens are committed, so their size matters. */
function toRgbPng(png) {
    const img = decodePng(png);
    if (img.channels === 3) return { img, bytes: encodePng(img.width, img.height, img.data, { channels: 3 }) };
    const n = img.width * img.height, rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
        rgb[i * 3] = img.data[i * img.channels];
        rgb[i * 3 + 1] = img.data[i * img.channels + 1];
        rgb[i * 3 + 2] = img.data[i * img.channels + 2];
    }
    const out = { width: img.width, height: img.height, channels: 3, data: rgb };
    return { img: out, bytes: encodePng(img.width, img.height, rgb, { channels: 3 }) };
}

async function main() {
    const opt = parseArgs(process.argv.slice(2));
    if (opt.help) {
        const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
        console.log(lines.slice(1, lines.findIndex((l, i) => i > 0 && !l.startsWith('//'))).map((l) => l.slice(3)).join('\n'));
        return 0;
    }
    if (opt.list) {
        for (const s of GOLDEN_SCENES) console.log(`${s.name.padEnd(34)} ${s.mobile ? '390×844@3' : '1440×900 '} ${s.text ? 'text  ' : 'canvas'} ${s.url}`);
        return 0;
    }
    const scenes = opt.only.length ? GOLDEN_SCENES.filter((s) => opt.only.includes(s.name)) : GOLDEN_SCENES;
    if (!scenes.length) {
        console.error(`golden: no scene matches --only=${opt.only.join(',')} (see --list)`);
        return 2;
    }
    const exe = opt.browser ?? findChrome();
    if (!exe) {
        console.error('golden: no Chrome/Edge found (set CHROME_PATH)');
        return 2;
    }
    const metaFile = path.join(opt.dir, 'meta.json');
    const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : null;
    const platform = `${process.platform}-${process.arch}`;
    const skip = (reason) => {
        console.log(`golden: SKIP: ${reason}. Nothing was compared; see scripts/golden.mjs to make goldens with this Chrome.`);
        annotate('notice', 'Golden renders skipped', `${reason}. Nothing was compared: run the CI workflow by hand with 'Render goldens' and commit its 'goldens' artifact to test/golden/.`);
        summary(`**Golden renders skipped:** ${reason}.`);
        return 0;
    };
    // Compare mode: nothing is rendered unless goldens exist for this Chrome and platform.
    if (!opt.update) {
        if (!meta) return skip(goldenUsable(null, {}).reason);
        let chrome;
        try {
            chrome = await browserVersion(exe);
        } catch (err) {
            console.error(`golden: cannot start the browser: ${err.message}`);
            return 2;
        }
        const pre = goldenUsable(meta, { chrome, platform });
        if (!pre.usable) return skip(pre.reason);
    }

    const server = createStaticServer(ROOT);
    const base = await server.listen(0, '127.0.0.1');
    fs.mkdirSync(opt.out, { recursive: true });
    const report = { mode: opt.update ? 'update' : 'compare', chrome: null, platform, renderer: null, scenes: [] };
    let failed = 0;
    try {
        for (const scene of scenes) {
            const t0 = Date.now();
            let r;
            try {
                r = await renderScene(scene, base, exe);
            } catch (err) {
                console.log(`  FAIL  ${scene.name.padEnd(34)} ${err.message}`);
                report.scenes.push({ name: scene.name, ok: false, error: err.message });
                failed++;
                continue;
            }
            report.chrome ??= r.chrome;
            if (!scene.text && r.settle.renderer) report.renderer ??= r.settle.renderer;
            if (!opt.update) {
                const u = goldenUsable(meta, { chrome: r.chrome, platform, renderer: scene.text ? null : r.settle.renderer });
                if (!u.usable) return skip(u.reason);
            }
            const secs = `${((Date.now() - t0) / 1000).toFixed(0)} s`;
            const problems = [...(r.settle.settled ? [] : ['never settled']), ...r.errors.map((e) => `console: ${e.split('\n')[0]}`)];
            const entry = { name: scene.name, tier: r.settle.tier, waitedMs: r.settle.waitedMs, problems };
            report.scenes.push(entry);
            if (scene.text) {
                fs.writeFileSync(path.join(opt.out, `${scene.name}.txt`), `${r.lines.join('\n')}\n`);
                if (opt.update) {
                    fs.mkdirSync(opt.dir, { recursive: true });
                    fs.writeFileSync(path.join(opt.dir, `${scene.name}.txt`), `${r.lines.join('\n')}\n`);
                    entry.ok = !problems.length;
                    console.log(`  ${entry.ok ? 'new ' : 'FAIL'}  ${scene.name.padEnd(34)} ${r.lines.length} structure lines  ${secs}${problems.length ? `  ${problems.join('; ')}` : ''}`);
                    if (!entry.ok) failed++;
                    continue;
                }
                const goldFile = path.join(opt.dir, `${scene.name}.txt`);
                if (!fs.existsSync(goldFile)) {
                    console.log(`  skip  ${scene.name.padEnd(34)} no golden (--update makes one)`);
                    entry.ok = true;
                    entry.skipped = true;
                    continue;
                }
                const diff = diffLines(fs.readFileSync(goldFile, 'utf8').split('\n').filter(Boolean), r.lines);
                entry.ok = diff.length === 0 && !problems.length;
                entry.diff = diff;
                console.log(`  ${entry.ok ? 'ok  ' : 'FAIL'}  ${scene.name.padEnd(34)} ${diff.length ? `${diff.length} structure lines differ` : 'same structure'}  ${secs}`
                    + `${problems.length ? `  ${problems.join('; ')}` : ''}`);
                if (diff.length) console.log(`        ${diff.join('\n        ')}`);
                if (!entry.ok) { failed++; annotate('error', `Golden ${scene.name}`, [...diff, ...problems].join('\n')); }
                continue;
            }
            const { img, bytes } = toRgbPng(r.png);
            fs.writeFileSync(path.join(opt.out, `${scene.name}.png`), bytes);
            entry.size = `${img.width}×${img.height}`;
            if (opt.update) {
                fs.mkdirSync(opt.dir, { recursive: true });
                fs.writeFileSync(path.join(opt.dir, `${scene.name}.png`), bytes);
                entry.ok = !problems.length;
                entry.bytes = bytes.length;
                console.log(`  ${entry.ok ? 'new ' : 'FAIL'}  ${scene.name.padEnd(34)} ${entry.size} ${(bytes.length / 1024).toFixed(0)} KB, ${r.settle.tier}  ${secs}`
                    + `${problems.length ? `  ${problems.join('; ')}` : ''}`);
                if (!entry.ok) failed++;
                continue;
            }
            const goldFile = path.join(opt.dir, `${scene.name}.png`);
            if (!fs.existsSync(goldFile)) {
                console.log(`  skip  ${scene.name.padEnd(34)} no golden (--update makes one)`);
                entry.ok = true;
                entry.skipped = true;
                continue;
            }
            const cmp = compareImages(decodePng(fs.readFileSync(goldFile)), img);
            if (cmp.heat) fs.writeFileSync(path.join(opt.out, `${scene.name}.diff.png`), encodePng(cmp.width, cmp.height, cmp.heat, { channels: 3, level: 6 }));
            entry.ok = cmp.ok && !problems.length;
            Object.assign(entry, { changed: cmp.changed, fraction: cmp.fraction, maxDelta: cmp.maxDelta, reason: cmp.reason });
            const pct = `${(cmp.fraction * 100).toFixed(3)} % changed (max Δ ${cmp.maxDelta})`;
            console.log(`  ${entry.ok ? 'ok  ' : 'FAIL'}  ${scene.name.padEnd(34)} ${cmp.reason && !cmp.ok ? cmp.reason : pct}  ${secs}`
                + `${problems.length ? `  ${problems.join('; ')}` : ''}`);
            if (!entry.ok) {
                failed++;
                annotate('error', `Golden ${scene.name}`, `${cmp.reason ?? pct}${problems.length ? `; ${problems.join('; ')}` : ''}. The heat map is ${scene.name}.diff.png in the golden-renders artifact.`);
            }
        }
    } finally {
        await server.close();
    }
    if (opt.update && !failed) {
        const scenesMeta = {};
        for (const e of report.scenes) {
            const s = GOLDEN_SCENES.find((x) => x.name === e.name);
            scenesMeta[e.name] = { file: `${e.name}.${s.text ? 'txt' : 'png'}`, url: s.url, viewport: s.mobile ? '390x844@3' : '1440x900@1', ...(e.size ? { size: e.size } : {}) };
        }
        const prev = meta && meta.chrome === report.chrome && meta.platform === platform ? meta.scenes : {};
        const next = {
            chrome: report.chrome, platform, renderer: report.renderer, generated: new Date().toISOString(),
            ci: process.env.CI === 'true', threshold: LUMA_THRESHOLD, maxFraction: MAX_CHANGED_FRACTION,
            scenes: { ...(opt.only.length ? prev : {}), ...scenesMeta },
        };
        fs.mkdirSync(opt.dir, { recursive: true });
        fs.writeFileSync(metaFile, `${JSON.stringify(next, null, 2)}\n`);
        console.log(`golden: wrote ${report.scenes.length} golden(s) and meta.json to ${path.relative(ROOT, opt.dir) || opt.dir} (Chrome ${report.chrome}, ${platform})`);
    }
    fs.writeFileSync(path.join(opt.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    if (!opt.update) {
        summary(`**Golden renders:** ${report.scenes.length - failed}/${report.scenes.length} match (Chrome ${report.chrome}).`);
        console.log(failed ? `golden: FAIL (${failed} of ${report.scenes.length}); renders and heat maps in ${path.relative(ROOT, opt.out)}/` : 'golden: PASS');
    }
    return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await main();
}
