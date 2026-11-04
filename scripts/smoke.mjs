#!/usr/bin/env node
// Zero-dependency headless smoke test for Planet Location Marker.
//
// Serves the repo over HTTP, opens a page in headless Chrome/Edge (SwiftShader WebGL2) via
// the DevTools protocol, records console errors / exceptions (page and workers) / network
// activity, optionally waits for the app, evaluates an expression, runs the SPEC §H
// acceptance assertions and writes a screenshot.
//
//   node scripts/smoke.mjs [options]
//
//   --url=/index.html#hash   page to open, relative to the site root (default /)
//   --out=shot.png           screenshot path (default: <tmp>/smoke[-mobile].png|jpg)
//   --wait=ms                fixed wait, or the ready deadline with --expect-ready/--assert
//                            (default 8000; 15000 with --expect-ready/--assert)
//   --width= --height=       viewport (default 1440×900; 390×844 with --mobile)
//   --dpr=n                  device pixel ratio (default 1; 3 with --mobile)
//   --mobile                 phone emulation: 390×844 @3, mobile, touch, mobile UA
//   --eval="js expr"         evaluated (awaited) after load; result is printed
//   --block=host1,host2      make these hosts unresolvable
//   --offline                make EVERY host except 127.0.0.1 unresolvable
//   --expect-ready           poll window.__app.ready every 250 ms until --wait
//   --assert                 SPEC §H acceptance checks (implies --expect-ready)
//   --format=png|jpeg --quality=0..100   screenshot encoding (quality: jpeg only)
//   --tz=Area/City           emulate a time zone (e.g. --tz=UTC to regression-test UTC systems)
//   --reduced-motion         emulate prefers-reduced-motion: reduce
//   --subpath=/repo/         serve the site under a sub-path, like GitHub Pages
//   --json=file              also write the results as JSON
//   --verbose                echo console messages and requests as they happen
//   --at=ms,ms,…             extra screenshots this long after navigation (<out>-<ms>.png),
//                            e.g. to film the first-visit intro; the run waits for the last one
//   --fail=path,path         answer requests whose URL path contains one of these with HTTP 404
//                            (CDP Fetch; failure-matrix tests). Expected failures are not judged
//   --no-webgl               launch the browser with WebGL disabled (text-mode tests)
//   --init="js"              evaluated in every new document before the page's own scripts
//   --gpu                    render on the machine's real GPU instead of SwiftShader (driver-specific bugs)
//   --angle=d3d11|gl|vulkan  ANGLE backend used with --gpu (default: d3d11 on Windows, platform default elsewhere)
//   --headed                 open a visible browser window instead of headless mode
//   --browser=chrome|edge|<path>   browser executable (default: first Chrome/Edge found)
//   --root=dir               serve this directory instead of the repo (e.g. the staged Pages artifact)
//   --chrome-args=a,b        extra browser command-line switches (e.g. --force_low_power_gpu)
//   --throttle=rtt,kbps      emulate a slow network: round-trip latency (ms) and download speed
//                            (kbit/s), e.g. --throttle=150,9000 (CDP Network.emulateNetworkConditions)
//   --offline-reload         the service worker's offline promise: opens the page with #sw=1, waits
//                            for the worker to control it and reply 'precached', then goes offline
//                            (CDP offline emulation, and the server stops) and reloads. The reload
//                            must get ready, receive the astro worker's events and be served by the
//                            worker alone; the other checks then run offline. Use it on the staged
//                            site (--root=_site after node scripts/stage-site.mjs _site) to test the
//                            deploy's manifest; on the repo it tests the dev worker
//   --context-loss           WEBGL_lose_context: lose and restore the context once the app is ready;
//                            drawing must resume, the overlay leave and no WebGL warning appear
//
// Exit codes: 0 pass · 1 errors or failed assertions · 2 infrastructure problem.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from './lib/http.mjs';
import { findChrome, launchChrome, CdpClient } from './lib/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ options --------------

const KNOWN_FLAGS = new Set(['url', 'out', 'wait', 'width', 'height', 'dpr', 'mobile', 'eval', 'block', 'offline',
    'expect-ready', 'assert', 'format', 'quality', 'tz', 'reduced-motion', 'subpath', 'json', 'verbose', 'help',
    'at', 'fail', 'no-webgl', 'init', 'gpu', 'angle', 'headed', 'browser', 'root', 'chrome-args', 'throttle',
    'offline-reload', 'context-loss']);
const GEOCODER_HOSTS = new Set(['geocoding-api.open-meteo.com', 'photon.komoot.io', 'nominatim.openstreetmap.org']);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
if (args.help) {
    const head = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 60);
    console.log(head.filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    process.exit(0);
}
for (const k of Object.keys(args)) if (!KNOWN_FLAGS.has(k)) console.warn(`smoke: unknown option --${k} (ignored)`);

const flag = (k) => args[k] !== undefined && args[k] !== 'false';
const ASSERT = flag('assert');
const OFFLINE_RELOAD = flag('offline-reload');
const CONTEXT_LOSS = flag('context-loss');
const EXPECT_READY = ASSERT || flag('expect-ready') || OFFLINE_RELOAD || CONTEXT_LOSS;
const MOBILE = flag('mobile');
const FORMAT = /^jpe?g$/i.test(args.format ?? '') ? 'jpeg' : 'png';
/** `url` with `flag` (e.g. 'sw=1') in its hash. */
const withHashFlag = (url, f) => (url.includes('#') ? `${url}${/[#&]$/.test(url) ? '' : '&'}${f}` : `${url}#${f}`);
const OPT = {
    url: OFFLINE_RELOAD ? withHashFlag(args.url ?? '/', 'sw=1') : args.url ?? '/',
    wait: Number(args.wait ?? (EXPECT_READY ? 15000 : 8000)),
    width: Number(args.width ?? (MOBILE ? 390 : 1440)),
    height: Number(args.height ?? (MOBILE ? 844 : 900)),
    dpr: Number(args.dpr ?? (MOBILE ? 3 : 1)),
    quality: Math.max(0, Math.min(100, Math.round(Number(args.quality ?? 85)))),
    out: args.out ?? path.join(os.tmpdir(), `smoke${MOBILE ? '-mobile' : ''}.${FORMAT === 'jpeg' ? 'jpg' : 'png'}`),
    tz: args.tz && args.tz !== 'true' ? args.tz : null,
    reducedMotion: flag('reduced-motion'),
    offline: flag('offline'),
    block: (args.block ?? '').split(',').map((s) => s.trim()).filter((s) => s && s !== 'true'),
    subpath: args.subpath && args.subpath !== 'true' ? args.subpath : null,
    json: args.json && args.json !== 'true' ? args.json : null,
    verbose: flag('verbose'),
    at: (args.at ?? '').split(',').map(Number).filter((n) => n > 0).sort((a, b) => a - b),
    fail: (args.fail ?? '').split(',').map((s) => s.trim()).filter((s) => s && s !== 'true'),
    noWebgl: flag('no-webgl'),
    init: args.init && args.init !== 'true' ? args.init : null,
    gpu: flag('gpu'),
    angle: args.angle && args.angle !== 'true' ? args.angle : null,
    headed: flag('headed'),
    browser: args.browser && args.browser !== 'true' ? args.browser : null,
    root: args.root && args.root !== 'true' ? path.resolve(args.root) : ROOT,
    chromeArgs: (args['chrome-args'] ?? '').split(',').map((s) => s.trim()).filter((s) => s && s !== 'true'),
    throttle: /^\d+,\d+$/.test(args.throttle ?? '') ? args.throttle.split(',').map(Number) : null,
};
for (const k of ['wait', 'width', 'height', 'dpr']) {
    if (!(OPT[k] > 0)) {
        console.error(`smoke: --${k} must be a positive number`);
        process.exit(2);
    }
}
const EXPECTED_VERSION = fs.readFileSync(path.join(ROOT, 'js', 'version.js'), 'utf8').match(/VERSION\s*=\s*'([^']+)'/)?.[1] ?? null;

// ------------------------------------------------------------------ state ----------------

const log = { errors: [], warnings: [], requests: [], failed: [], responses: [] };
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
const hostOf = (u) => {
    try {
        return new URL(u).host;
    } catch {
        return '';
    }
};
const isLocal = (u) => /^(data|blob|about|chrome-error):/.test(u) || LOCAL_HOSTS.has(hostOf(u).replace(/:\d+$/, ''));
const isForcedFailure = (u) => {
    try {
        const p = new URL(u).pathname;
        return OPT.fail.some((f) => p.includes(f));
    } catch {
        return false;
    }
};
const isGeocoder = (u) => GEOCODER_HOSTS.has(hostOf(u).replace(/:\d+$/, ''));
const verbose = (s) => OPT.verbose && console.log(s);

let server = null, chrome = null, cdp = null;
async function cleanup() {
    try {
        if (cdp) {
            await Promise.race([cdp.send('Browser.close').catch(() => {}), sleep(2000)]);
            cdp.close();
        }
    } catch { /* browser already gone */ }
    await chrome?.kill();
    await server?.close();
}
const watchdog = setTimeout(async () => {
    console.error('smoke: timed out');
    await cleanup();
    process.exit(2);
}, OPT.wait + 120000);
watchdog.unref();

// ------------------------------------------------------------------ helpers --------------

function hostRules() {
    if (OPT.offline) return 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1';
    return OPT.block.length ? OPT.block.map((h) => `MAP ${h} ~NOTFOUND`).join(', ') : null;
}

function argText(a) {
    if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
    return a.description ?? a.unserializableValue ?? a.type ?? '';
}

function wireEvents(client) {
    client.on('Runtime.consoleAPICalled', (p, sid) => {
        const text = p.args.map(argText).join(' ');
        const where = sid && sid !== client.pageSession ? '[worker] ' : '';
        if (p.type === 'error' || p.type === 'assert') log.errors.push(`console.${p.type}: ${where}${text}`);
        else if (p.type === 'warning') log.warnings.push(`${where}${text}`);
        verbose(`[${p.type}] ${where}${text}`);
    });
    client.on('Runtime.exceptionThrown', (p, sid) => {
        const d = p.exceptionDetails;
        const where = sid && sid !== client.pageSession ? '[worker] ' : '';
        log.errors.push(`exception: ${where}${d.exception?.description ?? d.text} @ ${d.url ?? ''}:${d.lineNumber ?? ''}`);
    });
    let workerSessions = 0;
    client.on('Log.entryAdded', ({ entry }) => {
        // Network failures are tracked (and judged) through the Network domain below, and
        // exceptions of attached workers already arrive through their own Runtime sessions.
        if (entry.source === 'network' || (entry.source === 'worker' && workerSessions > 0)) return;
        if (entry.level === 'error') log.errors.push(`${entry.source}: ${entry.text}${entry.url ? ` @ ${entry.url}` : ''}`);
        else if (entry.level === 'warning') log.warnings.push(`${entry.source}: ${entry.text}`);
    });
    const urls = new Map();
    client.on('Network.requestWillBeSent', (p, sid) => {
        urls.set(`${sid}|${p.requestId}`, p.request.url);
        log.requests.push(p.request.url);
        verbose(`→ ${p.request.method} ${p.request.url}`);
    });
    // The service worker's own fetches (an --offline-reload's network-first tries, which fail offline
    // by design) are not the page's: a page request the worker cannot serve fails on its own session.
    const swSessions = new Set();
    client.on('Network.loadingFailed', (p, sid) => {
        if (p.canceled || swSessions.has(sid)) return;
        log.failed.push({ url: urls.get(`${sid}|${p.requestId}`) ?? '?', why: p.errorText });
    });
    client.on('Network.responseReceived', (p, sid) => {
        if (swSessions.has(sid)) return;
        log.responses.push({ url: p.response.url, fromServiceWorker: !!p.response.fromServiceWorker });
        if (p.response.status >= 400) log.failed.push({ url: p.response.url, why: `HTTP ${p.response.status}` });
    });
    // Module workers (astro worker) get their own sessions; listen to their console, errors
    // and module requests too (a 404 inside the worker must fail the run like any other).
    client.on('Target.attachedToTarget', (p) => {
        if (!/worker/.test(p.targetInfo.type)) return;
        if (p.targetInfo.type === 'service_worker') swSessions.add(p.sessionId);
        workerSessions++;
        for (const m of ['Runtime.enable', 'Network.enable', 'Runtime.runIfWaitingForDebugger']) {
            client.send(m, {}, p.sessionId).catch(() => {});
        }
        if (OPT.fail.length) client.send('Fetch.enable', fetchPatterns(), p.sessionId).catch(() => {});
    });
    // --fail: forced 404s for the failure-matrix tests (page and worker sessions alike).
    client.on('Fetch.requestPaused', (p, sid) => {
        const forced = isForcedFailure(p.request.url);
        verbose(`${forced ? '✗ forced 404' : '· pass'} ${p.request.url}`);
        const reply = forced
            ? client.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 404, body: '' }, sid)
            : client.send('Fetch.continueRequest', { requestId: p.requestId }, sid);
        reply.catch(() => {});
    });
}

function fetchPatterns() {
    return { patterns: OPT.fail.map((f) => ({ urlPattern: `*${f}*`, requestStage: 'Request' })) };
}

function mobileUserAgent(desktopUa) {
    const major = desktopUa.match(/Chrome\/(\d+)/)?.[1] ?? '130';
    return `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
}

// ------------------------------------------------------------------ run ------------------

/** Launches the browser and returns a session-bound `page(method, params)` sender. */
async function openPage(exe) {
    try {
        chrome = await launchChrome({ executable: exe, width: OPT.width, height: OPT.height, hostRules: hostRules(), gpu: OPT.gpu, headed: OPT.headed, angle: OPT.angle,
            extraArgs: ['--enable-automation', ...OPT.chromeArgs, ...(OPT.noWebgl ? ['--disable-3d-apis', '--disable-webgl', '--disable-webgl2'] : [])] });
        cdp = await CdpClient.connect(chrome.wsUrl);
    } catch (err) {
        throw Object.assign(err, { infra: true });
    }
    wireEvents(cdp);
    const { userAgent } = await cdp.send('Browser.getVersion');
    const { targetInfos } = await cdp.send('Target.getTargets');
    let targetId = targetInfos.find((t) => t.type === 'page')?.targetId;
    if (!targetId) ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.pageSession = sessionId;
    const page = (method, params) => cdp.send(method, params, sessionId);

    // Emulation must be in place before navigation.
    for (const d of ['Page', 'Runtime', 'Network', 'Log']) await page(`${d}.enable`);
    await page('Network.setCacheDisabled', { cacheDisabled: true });
    if (OPT.throttle) {
        const [latency, kbps] = OPT.throttle;
        await page('Network.emulateNetworkConditions', {
            offline: false, latency, downloadThroughput: (kbps * 1000) / 8, uploadThroughput: (kbps * 1000) / 8,
        });
    }
    await page('Emulation.setDeviceMetricsOverride', { width: OPT.width, height: OPT.height, deviceScaleFactor: OPT.dpr, mobile: MOBILE });
    if (MOBILE) {
        await page('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await page('Emulation.setUserAgentOverride', { userAgent: mobileUserAgent(userAgent), platform: 'Android' });
    }
    if (OPT.tz) await page('Emulation.setTimezoneOverride', { timezoneId: OPT.tz });
    if (OPT.reducedMotion) {
        await page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    }
    if (OPT.fail.length) await page('Fetch.enable', fetchPatterns());
    if (OPT.init) await page('Page.addScriptToEvaluateOnNewDocument', { source: OPT.init });
    if (OFFLINE_RELOAD) await page('Page.addScriptToEvaluateOnNewDocument', { source: COUNT_EVENTS });
    await page('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    return page;
}

// --offline-reload: counts the bus 'events' payloads (the astro worker's event search) from the
// moment the app creates its bus, so the count cannot miss an early emit.
const COUNT_EVENTS = `(() => {
    let app;
    Object.defineProperty(window, '__app', { configurable: true, get() { return app; }, set(v) {
        app = v;
        const t0 = Date.now();
        const t = setInterval(() => {
            const bus = v && v.internals && v.internals.bus;
            if (!bus && Date.now() - t0 < 30000) return;
            clearInterval(t);
            if (bus) bus.on('events', (l) => { window.__smokeEvents = (window.__smokeEvents || 0) + (Array.isArray(l) ? l.length : 0); });
        }, 20);
    } });
})();`;

/** Polls a JS expression every 250 ms until it is truthy or `ms` pass; returns its value or null. */
async function pollFor(evaluate, expression, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const v = await evaluate(expression).catch(() => null);
        if (v) return v;
        await sleep(250);
    }
    return null;
}

/** Polls window.__app.ready every 250 ms until the deadline; returns ms since t0 or null. */
async function waitForReady(evaluate, t0) {
    const deadline = t0 + OPT.wait;
    while (Date.now() < deadline) {
        if (await evaluate('window.__app?.ready === true').catch(() => false)) return Date.now() - t0;
        await sleep(250);
    }
    return null;
}

function describeRun(target, exe) {
    const bits = [`${OPT.width}×${OPT.height} @${OPT.dpr}`];
    if (MOBILE) bits.push('mobile');
    if (OPT.offline) bits.push('offline');
    if (OPT.block.length) bits.push(`blocked ${OPT.block.join(',')}`);
    if (OPT.tz) bits.push(`tz=${OPT.tz}`);
    if (OPT.reducedMotion) bits.push('reduced motion');
    if (OPT.noWebgl) bits.push('no WebGL');
    if (OPT.fail.length) bits.push(`404 for ${OPT.fail.join(',')}`);
    if (OPT.throttle) bits.push(`throttled to ${OPT.throttle[0]} ms RTT, ${OPT.throttle[1]} kbit/s`);
    if (OFFLINE_RELOAD) bits.push('offline reload through the service worker');
    if (CONTEXT_LOSS) bits.push('context loss and restore');
    console.log(`smoke: ${target}\n       ${bits.join(', ')}; ${exe.split(/[\\/]/).pop()}`);
}

async function run() {
    server = createStaticServer(OPT.root, { prefix: OPT.subpath ?? undefined });
    const base = await server.listen(0, '127.0.0.1');
    const target = new URL(OPT.url.replace(/^\/+/, ''), base).href;
    const BROWSERS = {
        chrome: ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'],
        edge: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/microsoft-edge'],
    };
    const exe = OPT.browser
        ? (BROWSERS[OPT.browser.toLowerCase()] ?? [OPT.browser]).find((p) => fs.existsSync(p)) ?? null
        : findChrome();
    if (!exe) throw Object.assign(new Error('no Chrome/Edge found (set CHROME_PATH)'), { infra: true });
    const page = await openPage(exe);

    const evaluate = async (expression) => {
        const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
    };
    const stats = () => evaluate(`(() => { try { return JSON.parse(JSON.stringify(window.__app.stats())); }
        catch (e) { return { error: String(e && e.message || e) }; } })()`).catch((e) => ({ error: e.message }));

    describeRun(target, exe);
    const t0 = Date.now();
    await page('Page.navigate', { url: target });

    // ---- --at: timed screenshots (e.g. the intro), taken while the run below proceeds
    const shotAt = (ms) => sleep(Math.max(0, t0 + ms - Date.now()))
        .then(() => page('Page.captureScreenshot', { format: 'png' }))
        .then((r) => {
            const file = OPT.out.replace(/(.[a-z]+)?$/i, `-${ms}.png`);
            fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
            fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
            return path.resolve(file);
        })
        .catch((e) => `${ms} ms: ${e.message}`);
    const timedShots = Promise.all(OPT.at.map(shotAt));

    // ---- load: fixed wait, or poll for window.__app.ready
    let readyMs = null;
    if (EXPECT_READY) {
        readyMs = await waitForReady(evaluate, t0);
        check('ready', readyMs !== null, readyMs === null ? `not ready after ${OPT.wait / 1000} s` : `${(readyMs / 1000).toFixed(1)} s`);
    } else {
        await sleep(OPT.wait);
    }

    // ---- let the first-visit intro finish (≈ 4.5 s), so screenshots show the settled framing
    const atFiles = await timedShots;
    if (readyMs !== null && !OPT.at.length) {
        const introBy = Date.now() + 8000;
        while (Date.now() < introBy
            && await evaluate('window.__app?.store?.get?.()?.status?.introPlaying === true').catch(() => false)) {
            await sleep(250);
        }
        await sleep(600);   // a few frames after the camera settles
    }

    // ---- --context-loss, then --offline-reload (the checks below then run on the reloaded page)
    if (CONTEXT_LOSS && readyMs !== null) await contextLoss(evaluate);
    if (OFFLINE_RELOAD && readyMs !== null) readyMs = await offlineReload(page, evaluate) ?? readyMs;

    // ---- optional user expression, then the screenshot
    let evalResult;
    if (args.eval) evalResult = await evaluate(args.eval).catch((e) => `threw: ${e.message}`);
    const shot = await page('Page.captureScreenshot', FORMAT === 'jpeg' ? { format: 'jpeg', quality: OPT.quality } : { format: 'png' });
    fs.mkdirSync(path.dirname(path.resolve(OPT.out)), { recursive: true });
    fs.writeFileSync(OPT.out, Buffer.from(shot.data, 'base64'));

    // ---- SPEC §H acceptance
    let final = null;
    if (ASSERT && readyMs !== null) final = await acceptance({ evaluate, stats });

    return { target, readyMs, evalResult, final, shot: true, atFiles };
}

/**
 * --context-loss: WEBGL_lose_context, 400 ms lost, then restored. The render context must leave its
 * lost state (the closed maps re-fetched), the overlay go, five frames be drawn (time runs at 1 h/s
 * meanwhile, at most 30 s, then the clock is put back) and no WebGL warning be logged.
 */
async function contextLoss(evaluate) {
    const warnBefore = log.warnings.length;
    const r = await evaluate(`(async () => {
        const rc = window.__app && window.__app.internals && window.__app.internals.rc;
        if (!rc || !rc.renderer) return { error: 'no render context (text mode?)' };
        const canvas = rc.renderer.domElement;
        const ext = rc.renderer.getContext().getExtension('WEBGL_lose_context');
        if (!ext) return { error: 'no WEBGL_lose_context' };
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const once = (type) => new Promise((r) => canvas.addEventListener(type, r, { once: true }));
        const overlay = () => !!document.getElementById('pc-context-lost');
        const c = window.__app.clock, wasLive = c.live, t0 = c.tMs, rate = c.rate, playing = c.playing;
        const lost = once('webglcontextlost');
        ext.loseContext();
        await lost;
        await sleep(400);
        const shown = overlay();
        const restored = once('webglcontextrestored');
        const tr = performance.now();
        ext.restoreContext();
        await restored;
        while (rc.lost && performance.now() - tr < 20000) await sleep(100);
        const restoreMs = Math.round(performance.now() - tr);
        const f0 = window.__app.stats().frames;
        c.setRate(3600);
        c.play();
        // The first frame after a restore links the shaders again: seconds on SwiftShader.
        const tf = performance.now();
        while (window.__app.stats().frames - f0 < 5 && performance.now() - tf < 30000) await sleep(100);
        const frames = window.__app.stats().frames - f0, framesMs = Math.round(performance.now() - tf);
        if (wasLive) c.goLive(); else { c.setTime(t0); c.setRate(rate); if (!playing) c.pause(); }
        return { stillLost: rc.lost, restoreMs, frames, framesMs, shown, gone: !overlay(), phase: window.__app.stats().phase };
    })()`).catch((e) => ({ error: e.message }));
    await sleep(500);   // a warning from the restore's last frames arrives asynchronously
    const glWarnings = log.warnings.slice(warnBefore).filter((w) => /webgl|gl_invalid|does not belong to this context/i.test(w));
    if (r?.error) {
        check('context loss', false, r.error);
        return;
    }
    check('context loss: overlay while lost', r.shown, r.shown ? 'shown' : 'not shown');
    check('context loss: restored', !r.stillLost && r.gone && r.phase === 'ready',
        `${r.restoreMs} ms, overlay ${r.gone ? 'gone' : 'still up'}, phase=${r.phase}`);
    check('context loss: frames resume', r.frames >= 5, `${r.frames} frames in ${(r.framesMs / 1000).toFixed(1)} s`);
    check('context loss: no WebGL warnings', glWarnings.length === 0,
        glWarnings.length ? `${glWarnings.length}: ${[...new Set(glWarnings)].slice(0, 2).join(' | ')}` : '0');
}

/**
 * --offline-reload: the worker must control the page and have precached it; then the page goes
 * offline (CDP emulation, and the server stops: a request the worker forwards fails) and reloads.
 * Returns the reload's ready time, or null.
 */
async function offlineReload(page, evaluate) {
    const sw = await pollFor(evaluate, `(() => { const s = window.__app && window.__app.sw;
        return s && s.controlled && s.precached ? JSON.parse(JSON.stringify(s)) : null; })()`, 45000);
    check('service worker: controls, precached', !!sw, sw ? `${sw.version}${sw.staged ? ' (staged manifest)' : ' (dev: no manifest)'}` : 'not within 45 s');
    if (!sw) return null;
    const staged = fs.existsSync(path.join(OPT.root, 'sw-manifest.json'))
        ? JSON.parse(fs.readFileSync(path.join(OPT.root, 'sw-manifest.json'), 'utf8')) : null;
    if (staged) check('service worker: the manifest\'s version', sw.version === staged.version && sw.staged, `${sw.version} (sw-manifest.json: ${staged.version})`);
    const cached = await evaluate(`(async () => { let n = 0; for (const k of await caches.keys()) if (k.startsWith('pc2-')) n += (await (await caches.open(k)).keys()).length; return n; })()`).catch(() => 0);
    if (staged) check('service worker: precache complete', cached >= staged.precache.length, `${cached} cached / ${staged.precache.length} precached files`);

    await page('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await server.close();
    server = null;
    const mark = log.responses.length;
    const t1 = Date.now();
    await page('Page.reload', {});
    const readyMs = await waitForReady(evaluate, t1);
    check('offline reload: ready', readyMs !== null, readyMs === null ? `not ready after ${OPT.wait / 1000} s` : `${(readyMs / 1000).toFixed(1)} s`);
    if (readyMs === null) return null;
    const controlled = await evaluate('window.__app.sw.controlled === true').catch(() => false);
    check('offline reload: controlled', controlled, controlled ? 'by the service worker' : 'no controller');
    const events = await pollFor(evaluate, '(window.__smokeEvents || 0) > 0 ? window.__smokeEvents : null', 30000);
    check('offline reload: events', events > 0, `${events ?? 0} events from the astro worker`);
    const toast = await evaluate(`document.querySelector('.toasts')?.textContent ?? ''`).catch(() => '');
    check('offline reload: every image', !/couldn.t load/i.test(toast), /couldn.t load/i.test(toast) ? 'the imagery toast showed' : 'no imagery toast');
    const after = log.responses.slice(mark).filter((r) => /^https?:/.test(r.url) && isLocal(r.url));
    const fromSw = after.filter((r) => r.fromServiceWorker).length;
    check('offline reload: served by the worker', after.length > 0 && fromSw === after.length, `${fromSw}/${after.length} responses`);
    return readyMs;
}

/** SPEC §H: stats sanity, version, and memory stability while time runs at 1 day/s. */
async function acceptance({ evaluate, stats }) {
    const first = await stats();
    if (first.error) {
        check('stats()', false, first.error);
        return first;
    }
    const version = await evaluate('window.__app.version').catch(() => null);
    check('version', !EXPECTED_VERSION || version === EXPECTED_VERSION, `${version} (js/version.js: ${EXPECTED_VERSION})`);

    // Deferred textures stream in after "ready"; wait until resource counts are stable for
    // 2 s (max 10 s) so the leak check measures steady state, not the loader.
    let prev = first, stableSince = Date.now();
    const settleBy = Date.now() + 10000;
    while (Date.now() < settleBy && Date.now() - stableSince < 2000) {
        await sleep(400);
        const s = await stats();
        if (s.geometries !== prev.geometries || s.textures !== prev.textures) stableSince = Date.now();
        prev = s;
    }
    await interfaceChecks(evaluate);
    const started = await evaluate('(() => { const c = window.__app.clock; c.setRate(86400); c.play(); return true; })()')
        .catch((e) => `threw: ${e.message}`);
    check('clock.setRate(86400); play()', started === true, started === true ? 'ok' : String(started));
    const t = Date.now();
    await sleep(3000);
    const s3 = await stats();
    await sleep(Math.max(0, t + 10000 - Date.now()));
    const s10 = await stats();
    const memOk = !s3.error && !s10.error && s3.geometries === s10.geometries && s3.textures === s10.textures;
    check('memory stable (3 s → 10 s at 1 d/s)', memOk,
        `geometries ${s3.geometries}→${s10.geometries}, textures ${s3.textures}→${s10.textures}`);
    check('phase', s10.phase === 'ready', `phase=${s10.phase}`);
    if (OPT.noWebgl) {
        // Text mode never draws a frame: check that it stayed text-only instead.
        check('text mode (no frames, no beams)', !(s10.frames > 0) && !(s10.beamsVisible > 0),
            `frames=${s10.frames}, beamsVisible=${s10.beamsVisible}`);
    } else {
        check('frames > 10', s10.frames > 10, `frames=${s10.frames}`);
        // Beams belong to orbit view; sky view hides them by design (a --url with view=sky).
        const view = await evaluate('window.__app.store.get().view.mode').catch(() => null);
        if (view === 'sky') check('beams hidden in sky view', s10.beamsVisible === 0, `beamsVisible=${s10.beamsVisible}`);
        else check('beamsVisible ≥ 7', s10.beamsVisible >= 7, `beamsVisible=${s10.beamsVisible}`);
    }
    return s10;
}

// Layout checks that need a live page: a shared link's selection opens its card, and the phone
// time bar shows the whole date (with its year) on every weekday, including two-digit days.
async function interfaceChecks(evaluate) {
    if (/[#&]sel=[a-z]/.test(OPT.url)) {
        const tab = await evaluate(`document.getElementById('tab-details')?.getAttribute('aria-selected') ?? 'missing'`)
            .catch((e) => `threw: ${e.message}`);
        check('sel= opens Details', tab === 'true', `#tab-details aria-selected=${tab}`);
    }
    const layout = await evaluate(`document.getElementById('ui-root')?.dataset.layout ?? ''`).catch(() => '');
    if (layout !== 'mobile') return;
    // 4–17 Nov 2026 holds every weekday with one- and two-digit days ("Wed 11 Nov", "Mon 16 Nov").
    const clipped = await evaluate(`(async () => {
        const c = window.__app.clock, t0 = c.tMs, wasLive = c.live, wasPlaying = c.playing;
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const bad = [];
        c.pause();
        for (let k = 0; k < 14; k += 1) {
            c.setTime(Date.UTC(2026, 10, 4, 12) + k * 864e5);
            await frame();
            for (const el of document.querySelectorAll('.tb-date .stamp__day, .tb-date .stamp__time')) {
                if (el.scrollWidth > el.clientWidth) bad.push(el.textContent + ' (' + el.scrollWidth + '>' + el.clientWidth + ')');
            }
        }
        if (wasLive) c.goLive(); else { c.setTime(t0); if (wasPlaying) c.play(); }
        return bad;
    })()`).catch((e) => [`threw: ${e.message}`]);
    check('phone date unclipped (14 days)', Array.isArray(clipped) && clipped.length === 0,
        Array.isArray(clipped) && clipped.length ? clipped.slice(0, 3).join(', ') : 'all fit');
}

function judgeLogs() {
    const localFailures = log.failed.filter((f) => isLocal(f.url) && !f.url.endsWith('/favicon.ico') && !isForcedFailure(f.url));
    const external = [...new Set(log.requests.filter((u) => !isLocal(u)))];
    const badExternal = external.filter((u) => !isGeocoder(u));
    check('console', log.errors.length === 0, `${log.errors.length} errors/exceptions, ${log.warnings.length} warnings`);
    check('local requests', localFailures.length === 0,
        `${log.requests.filter(isLocal).length} requests, ${localFailures.length} failed`);
    // Boot must be network-free; only the optional geocoders may ever leave the machine.
    check('external requests', badExternal.length === 0,
        `${external.length} external (${external.length - badExternal.length} geocoder)`);
    return { localFailures, external, badExternal };
}

// ------------------------------------------------------------------ main -----------------

let result = null, infraError = null;
try {
    result = await run();
} catch (err) {
    if (err.infra) infraError = err;
    else check('run', false, err.message);
}
await cleanup();
clearTimeout(watchdog);

if (infraError) {
    console.error(`smoke: ${infraError.message}`);
    process.exit(2);
}
const net = judgeLogs();
// With --assert/--expect-ready every check is fatal; without, only console errors and a
// crashed run fail (the historical contract) and the network checks are advisory.
const STRICT = ASSERT || EXPECT_READY;
const fatal = (c) => STRICT || c.name === 'console' || c.name === 'run';
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
for (const c of checks) {
    let label = 'ok  ';
    if (!c.ok) label = fatal(c) ? 'FAIL' : 'warn';
    console.log(`  ${label}  ${pad(c.name, 38)} ${c.detail ?? ''}`);
}
if (result?.final && !result.final.error) {
    const f = result.final;
    console.log(`  info  stats  fps=${f.fps} frames=${f.frames} drawCalls=${f.drawCalls} geometries=${f.geometries} `
        + `textures=${f.textures} beams=${f.beamsVisible} labels=${f.labelsVisible}`);
}
if (result?.evalResult !== undefined) {
    const v = result.evalResult;
    console.log('eval:', typeof v === 'string' ? v : JSON.stringify(v, null, 2));
}
if (net.localFailures.length) console.log(`failed local requests:\n  ${net.localFailures.map((f) => `${f.why} ${f.url}`).join('\n  ')}`);
if (net.external.length) console.log(`external requests:\n  ${net.external.join('\n  ')}`);
const otherFailed = log.failed.filter((f) => !net.localFailures.includes(f));
if (otherFailed.length && OPT.verbose) console.log(`other failed requests:\n  ${otherFailed.map((f) => `${f.why} ${f.url}`).join('\n  ')}`);
if (log.warnings.length) console.log(`warnings (${log.warnings.length}):\n  ${[...new Set(log.warnings)].slice(0, 20).join('\n  ')}`);
if (log.errors.length) console.log(`ERRORS (${log.errors.length}):\n  ${log.errors.join('\n  ')}`);
for (const f of result?.atFiles ?? []) console.log(`screenshot: ${f}`);
if (result?.shot) console.log(`screenshot: ${path.resolve(OPT.out)}`);

const failed = checks.some((c) => !c.ok && fatal(c));
if (OPT.json) {
    fs.mkdirSync(path.dirname(path.resolve(OPT.json)), { recursive: true });
    fs.writeFileSync(OPT.json, JSON.stringify({
        ok: !failed, url: result?.target ?? null, viewport: { width: OPT.width, height: OPT.height, dpr: OPT.dpr, mobile: MOBILE },
        options: { offline: OPT.offline, tz: OPT.tz, reducedMotion: OPT.reducedMotion, subpath: OPT.subpath, noWebgl: OPT.noWebgl, fail: OPT.fail,
            offlineReload: OFFLINE_RELOAD, contextLoss: CONTEXT_LOSS, root: OPT.root === ROOT ? null : OPT.root },
        readyMs: result?.readyMs ?? null, checks, stats: result?.final ?? null, errors: log.errors, warnings: log.warnings,
        external: net.external, failed: log.failed, screenshot: result?.shot ? path.resolve(OPT.out) : null,
    }, null, 2));
}
console.log(failed ? 'FAIL' : 'PASS');
process.exit(failed ? 1 : 0);
