// Tests for js/core/url-state.js — round trips, clamping, fuzzing and the throttled binder.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseHash, serializeHash, bindUrl, layersToCode, codeToLayers, camToCode, LAYER_CODES, DEFAULT_LAYER_CODE,
} from '../js/core/url-state.js';
import { isExtraId } from '../js/core/selection.js';
import { DEFAULT_STATE, createStore } from '../js/core/store.js';
import { createClock, MIN_MS, MAX_MS, RATES } from '../js/core/clock.js';

const BODY_IDS = ['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
const LAYER_KEYS = Object.keys(DEFAULT_STATE.layers);
const ALLOWED_KEYS = new Set(['observer', 'observer2', 'tMs', 'live', 'rate', 'playing', 'view', 'earthLock', 'selection', 'layers', 'quality', 'skyDark', 'aurora', 'cam', 'track', 'intro', 'debug', 'invalid']);
const SPEC_EXAMPLE = '#loc=21.0285,105.8542&n=Hanoi&cc=VN&tz=Asia/Ho_Chi_Minh&el=15&t=2027-08-02T10:07:00Z&r=3600&p=1&view=orbit&lock=1&sel=moon'
    + '&ly=bgoscCnmkazhldw&q=auto&cam=o:21.0,105.8,3.2|s:142.3,25.0,60&intro=0&debug=1';

/** Asserts every invariant a parsed hash must satisfy. */
function assertValid(out, label) {
    for (const k of Object.keys(out)) assert.ok(ALLOWED_KEYS.has(k), `${label}: unexpected key ${k}`);
    if (out.observer) {
        const o = out.observer;
        assert.ok(Number.isFinite(o.latDeg) && Math.abs(o.latDeg) <= 90, `${label}: lat`);
        assert.ok(Number.isFinite(o.lonDeg) && o.lonDeg > -180 && o.lonDeg <= 180, `${label}: lon ${o.lonDeg}`);
        assert.ok(Number.isFinite(o.elevM) && o.elevM >= -500 && o.elevM <= 9000, `${label}: elev`);
        assert.equal(typeof o.name, 'string');
        assert.ok(o.name.length <= 80);
        assert.ok(!/[\u0000-\u001f]/.test(o.name), `${label}: control characters in name`);
        assert.ok(o.tz === null || typeof o.tz === 'string');
        assert.ok(/^([A-Z]{2})?$/.test(o.cc));
        assert.equal(o.source, 'url');
    }
    if ('tMs' in out) assert.ok(out.tMs >= MIN_MS && out.tMs <= MAX_MS, `${label}: t`);
    if ('rate' in out) assert.ok(RATES.includes(out.rate), `${label}: rate ${out.rate}`);
    for (const k of ['live', 'playing', 'earthLock', 'intro', 'debug']) if (k in out) assert.equal(typeof out[k], 'boolean', `${label}: ${k}`);
    if ('view' in out) assert.ok(['orbit', 'sky', 'map'].includes(out.view));
    if (out.observer2) {
        const o = out.observer2;
        assert.ok(Number.isFinite(o.latDeg) && Math.abs(o.latDeg) <= 90, `${label}: lat2`);
        assert.ok(Number.isFinite(o.lonDeg) && o.lonDeg > -180 && o.lonDeg <= 180, `${label}: lon2 ${o.lonDeg}`);
        assert.ok(o.name.length <= 80 && !/[\u0000-\u001f]/.test(o.name), `${label}: name2`);
        assert.equal(o.source, 'url');
    }
    if ('selection' in out) assert.ok(out.selection === null || BODY_IDS.includes(out.selection) || isExtraId(out.selection));
    if ('layers' in out) {
        assert.deepEqual(Object.keys(out.layers).sort(), [...LAYER_KEYS].sort());
        for (const v of Object.values(out.layers)) assert.equal(typeof v, 'boolean');
    }
    if ('quality' in out) assert.ok(['auto', 'low', 'medium', 'high', 'max'].includes(out.quality));
    if ('skyDark' in out) assert.ok(['auto', 'pristine', '1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(out.skyDark));
    if (out.cam) {
        const c = out.cam;
        if (c.mode === 'orbit') {
            assert.ok(Math.abs(c.latDeg) <= 90 && c.lonDeg > -180 && c.lonDeg <= 180 && c.distance >= 1.08 && c.distance <= 2e6, `${label}: cam`);
        } else if (c.mode === 'map') {
            assert.ok(Math.abs(c.latDeg) <= 90 && c.lonDeg > -180 && c.lonDeg <= 180 && c.distance >= 0.05 && c.distance <= 20, `${label}: map cam`);
        } else {
            assert.equal(c.mode, 'sky');
            assert.ok(c.azDeg >= 0 && c.azDeg < 360 && c.altDeg >= -10 && c.altDeg <= 89 && c.fovDeg >= 0.2 && c.fovDeg <= 100, `${label}: cam`);
        }
    }
    if (out.invalid) {
        assert.ok(out.invalid.length > 0);
        for (const k of out.invalid) assert.equal(typeof k, 'string');
    }
}

function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

test('parses the SPEC §F.4 example completely', () => {
    const p = parseHash(SPEC_EXAMPLE);
    assertValid(p, 'example');
    assert.deepEqual(p.observer, {
        latDeg: 21.0285, lonDeg: 105.8542, elevM: 15, name: 'Hanoi', country: '', cc: 'VN', tz: 'Asia/Ho_Chi_Minh', tzApprox: false, source: 'url',
    });
    assert.equal(p.tMs, Date.UTC(2027, 7, 2, 10, 7, 0));
    assert.equal(p.live, false);
    assert.equal(p.rate, 3600);
    assert.equal(p.playing, true);
    assert.equal(p.view, 'orbit');
    assert.equal(p.earthLock, true);
    assert.equal(p.selection, 'moon');
    // The example predates the deep-sky ('x') and satellite ('i') layers, both on by default: a link without them turns them off.
    assert.deepEqual(p.layers, { ...DEFAULT_STATE.layers, deepSky: false, satellites: false });
    assert.equal(p.quality, 'auto');
    assert.deepEqual(p.cam, { mode: 'orbit', latDeg: 21, lonDeg: 105.8, distance: 3.2 }, 'the part matching view');
    assert.equal(p.intro, false);
    assert.equal(p.debug, true);
    assert.equal(p.invalid, undefined);
    assert.deepEqual(parseHash(SPEC_EXAMPLE.replace('view=orbit', 'view=sky')).cam, { mode: 'sky', azDeg: 142.3, altDeg: 25, fovDeg: 60 });
});

test('the default layer code matches DEFAULT_STATE', () => {
    assert.equal(DEFAULT_LAYER_CODE, 'bgoscCnmkazhldxwi');
    assert.equal(LAYER_CODES.length, LAYER_KEYS.length);
    assert.deepEqual(codeToLayers('bgoscCnmkazhldxwi'), { layers: { ...DEFAULT_STATE.layers }, unknown: false });
    assert.equal(layersToCode(null), null);
});

test('round trip of every field', () => {
    const layers = Object.fromEntries(LAYER_KEYS.map((k, i) => [k, i % 3 !== 0]));
    const state = {
        ...DEFAULT_STATE,
        observer: {
            latDeg: -33.8679, lonDeg: 151.2073, elevM: 58, name: 'Sydney & "Harbour" #1 / 100% +ok', country: 'Australia', cc: 'au',
            tz: 'Australia/Sydney', tzApprox: false, source: 'city',
        },
        selection: 'saturn', view: { mode: 'sky', earthLock: false }, layers, quality: { setting: 'high', active: 'high', ceiling: 'high' },
    };
    const clock = { tMs: Date.UTC(2027, 7, 2, 10, 7, 0), rate: -3600, playing: false, live: false };
    const cam = { mode: 'sky', azDeg: 142.3, altDeg: 25, fovDeg: 60 };
    const hash = serializeHash({ state, clock, cam, extra: { intro: false, debug: true } });
    assert.ok(hash.startsWith('#loc=-33.8679,151.2073&'));
    const p = parseHash(hash);
    assertValid(p, 'round trip');
    assert.equal(p.invalid, undefined);
    assert.equal(p.observer.latDeg, -33.8679);
    assert.equal(p.observer.lonDeg, 151.2073);
    assert.equal(p.observer.elevM, 58);
    assert.equal(p.observer.name, state.observer.name, 'special characters survive');
    assert.equal(p.observer.cc, 'AU');
    assert.equal(p.observer.tz, 'Australia/Sydney');
    assert.equal(p.tMs, clock.tMs);
    assert.equal(p.live, false);
    assert.equal(p.rate, -3600);
    assert.equal(p.playing, false);
    assert.equal(p.view, 'sky');
    assert.equal(p.earthLock, false);
    assert.equal(p.selection, 'saturn');
    assert.deepEqual(p.layers, layers);
    assert.equal(p.quality, 'high');
    assert.deepEqual(p.cam, cam);
    assert.equal(p.intro, false);
    assert.equal(p.debug, true);
    // Serialising the parsed result again is stable.
    const again = serializeHash({
        state: { ...state, observer: p.observer, selection: p.selection, view: { mode: p.view, earthLock: p.earthLock }, layers: p.layers },
        clock: { tMs: p.tMs, rate: p.rate, playing: p.playing, live: p.live }, cam: p.cam, extra: { intro: p.intro, debug: p.debug },
    });
    assert.equal(again, hash);
});

test('round trip of the orbit camera and of an {orbit, sky} pair', () => {
    const orbit = { mode: 'orbit', latDeg: 21.03, lonDeg: -105.85, distance: 3.4 };
    assert.deepEqual(parseHash(`#cam=${camToCode(orbit)}`).cam, orbit);
    const pair = { orbit, sky: { mode: 'sky', azDeg: 10, altDeg: 45, fovDeg: 70 } };
    const code = camToCode(pair);
    assert.equal(code, 'o:21.03,-105.85,3.4|s:10,45,70');
    assert.deepEqual(parseHash(`#view=sky&cam=${code}`).cam, pair.sky);
    assert.deepEqual(parseHash(`#cam=${code}`).cam, orbit);
    assert.equal(camToCode({ kind: 'o', lat: 1, lon: 2, dist: 3 }), 'o:1,2,3', 'aliases accepted');
    assert.equal(camToCode({ type: 's', yaw: -30, pitch: 95, fov: 0.05 }), 's:330,89,0.2', 'clamped and wrapped');
    // The telescope zoom keeps three significant digits of a narrow field.
    assert.equal(camToCode({ mode: 'sky', az: 10, alt: 20, fov: 0.31234 }), 's:10,20,0.312');
    assert.equal(camToCode({ mode: 'sky', az: 10, alt: 20, fov: 2.4567 }), 's:10,20,2.46');
    assert.equal(camToCode({ mode: 'sky', az: 10, alt: 20, fov: 45.67 }), 's:10,20,45.7');
    assert.equal(camToCode('o:1,2,3|garbage'), 'o:1,2,3');
    assert.equal(camToCode({ mode: 'orbit', latDeg: 1 }), '');
    assert.equal(camToCode(42), '');
});

test('defaults keep links short; Live omits t', () => {
    const live = createClock({ now: () => Date.UTC(2026, 9, 11) });
    assert.equal(serializeHash({ state: DEFAULT_STATE, clock: live }),
        '#loc=51.4769,-0.0005&n=Royal%20Observatory%20Greenwich&tz=Europe/London');
    assert.equal(serializeHash({}), '');
    assert.equal(serializeHash(), '');
    const paused = createClock({ now: () => Date.UTC(2026, 9, 11, 12, 0, 0, 400), playing: false });
    assert.equal(serializeHash({ clock: paused }), '#t=2026-10-11T12:00:00Z&p=0', 'rounded to the second');
});

test('live semantics', () => {
    assert.deepEqual(parseHash(''), {});
    assert.deepEqual(parseHash('#'), {});
    assert.equal(parseHash('#t=now').live, true);
    assert.equal(parseHash('#r=1').live, true);
    assert.equal(parseHash('#p=1').live, true);
    assert.equal(parseHash('#r=60').live, false);
    assert.equal(parseHash('#p=0').live, false);
    assert.equal(parseHash('#t=2027-01-01').live, false);
    assert.equal(parseHash('#t=garbage&r=1').live, true, 'an unusable t falls back to now');
    assert.equal(parseHash('#loc=1,2').live, undefined, 'no time keys: say nothing');
});

test('time formats', () => {
    const p = (t) => parseHash(`#t=${t}`).tMs;
    assert.equal(p('2027-08-02T10:07:00Z'), Date.UTC(2027, 7, 2, 10, 7));
    assert.equal(p('2027-08-02T10:07Z'), Date.UTC(2027, 7, 2, 10, 7));
    assert.equal(p('2027-08-02T10:07:00.250Z'), Date.UTC(2027, 7, 2, 10, 7, 0, 250));
    assert.equal(p('2027-08-02T10:07:00'), Date.UTC(2027, 7, 2, 10, 7), 'no zone means UTC');
    assert.equal(p('2027-08-02T17:07:00%2B07:00'), Date.UTC(2027, 7, 2, 10, 7), 'offset (encoded +)');
    assert.equal(p('2027-08-02T05:07:00-05:00'), Date.UTC(2027, 7, 2, 10, 7));
    assert.equal(p('2027-08-02'), Date.UTC(2027, 7, 2));
    assert.equal(p('2027-08'), Date.UTC(2027, 7, 1));
    assert.equal(p('2027'), Date.UTC(2027, 0, 1));
    assert.equal(p('1817201220000'), 1817201220000, 'epoch milliseconds');
    for (const bad of ['2027-13-01', '2027-02-30', '2026-02-29', '2027-08-02T24:00', '2027-08-02T10:60', 'tomorrow', '', '2027-08-02T10:07:00+15:00']) {
        const out = parseHash(`#t=${bad}`);
        assert.equal(out.tMs, undefined, bad);
        assert.deepEqual(out.invalid, ['t'], bad);
    }
});

test('clamping and snapping', () => {
    const lon = parseHash('#loc=10,190').observer.lonDeg;
    assert.equal(lon, -170, 'longitude wraps');
    assert.equal(parseHash('#loc=10,-180').observer.lonDeg, 180);
    assert.equal(parseHash('#loc=10,540').observer.lonDeg, 180);
    const lat = parseHash('#loc=95,10');
    assert.equal(lat.observer, undefined, 'latitude out of range drops the observer');
    assert.deepEqual(lat.invalid, ['loc']);
    const early = parseHash('#t=0500-01-01T00:00:00Z');
    assert.equal(early.tMs, MIN_MS);
    assert.deepEqual(early.invalid, ['t'], 'clamped values are reported');
    assert.equal(parseHash('#t=0050-01-01').tMs, MIN_MS, 'years 0..99 are not mistaken for 19xx');
    assert.equal(parseHash('#t=3500-06-01').tMs, MAX_MS);
    assert.equal(parseHash('#r=5000').rate, 3600);
    assert.equal(parseHash('#r=-7').rate, -10);
    assert.equal(parseHash('#r=1e12').rate, 31557600);
    assert.deepEqual(parseHash('#r=0').invalid, ['r']);
    assert.deepEqual(parseHash('#r=fast').invalid, ['r']);
    const el = parseHash('#loc=1,2&el=99999');
    assert.equal(el.observer.elevM, 9000);
    assert.deepEqual(el.invalid, ['el']);
    assert.deepEqual(parseHash('#cam=o:95,370,5e7').cam, { mode: 'orbit', latDeg: 90, lonDeg: 10, distance: 2e6 });
    // Past 150 R is the solar-system zoom: kept, and written in whole radii from 1000 R.
    assert.deepEqual(parseHash('#cam=o:30,10,500').cam, { mode: 'orbit', latDeg: 30, lonDeg: 10, distance: 500 });
    assert.equal(camToCode({ mode: 'orbit', latDeg: 30, lonDeg: 10, distance: 140733.4 }), 'o:30,10,140733');
    assert.deepEqual(parseHash('#cam=s:-30,120,0.1').cam, { mode: 'sky', azDeg: 330, altDeg: 89, fovDeg: 0.2 });
    assert.deepEqual(parseHash('#cam=s:-30,120,0.5').cam, { mode: 'sky', azDeg: 330, altDeg: 89, fovDeg: 0.5 });
});

test('invalid values are dropped and reported; unknown keys are ignored', () => {
    const p = parseHash('#loc=1,2&tz=Foo/Bar&cc=USA&sel=pluto&q=ultra&view=side&p=maybe&lock=2&intro=x&debug=7&cam=x:1,2,3&ly=bXYZc&zzz=1');
    assert.equal(p.observer.tz, null);
    assert.equal(p.observer.cc, '');
    assert.equal(p.selection, undefined);
    assert.equal(p.quality, undefined);
    assert.equal(p.view, undefined);
    assert.equal(p.playing, undefined);
    assert.equal(p.earthLock, undefined);
    assert.equal(p.cam, undefined);
    assert.deepEqual(p.layers, { ...codeToLayers('').layers, beams: true, constellations: true }, 'known letters still apply');
    assert.deepEqual(p.invalid.sort(), ['cam', 'cc', 'debug', 'intro', 'lock', 'ly', 'p', 'q', 'sel', 'tz', 'view'].sort());
    assert.equal(parseHash('#zzz=1&foo').invalid, undefined, 'unknown keys are not "invalid"');
    assert.deepEqual(parseHash('#n=%E0%A4%A&loc=1,2').invalid, ['n'], 'malformed percent-encoding');
    assert.equal(parseHash('#n=%E0%A4%A&loc=1,2').observer.name, '');
});

test('time zones: aliases accepted as written, Etc zones flagged approximate', () => {
    assert.equal(parseHash('#loc=10.8,106.6&tz=Asia/Saigon').observer.tz, 'Asia/Saigon');
    assert.equal(parseHash('#loc=10.8,106.6&tz=Asia/Ho_Chi_Minh').observer.tz, 'Asia/Ho_Chi_Minh');
    assert.equal(parseHash('#loc=0,0&tz=UTC').observer.tz, 'UTC');
    assert.equal(parseHash('#loc=0,0&tz=Etc/UTC').observer.tz, 'Etc/UTC');
    const approx = parseHash('#loc=0,105&tz=Etc/GMT-7').observer;
    assert.equal(approx.tz, 'Etc/GMT-7');
    assert.equal(approx.tzApprox, true);
    assert.equal(parseHash('#loc=0,-75&tz=Etc/GMT%2B5').observer.tz, 'Etc/GMT+5', '+ in a zone is not a space');
});

test('layers code is the exact enabled set and case-sensitive', () => {
    const junk = parseHash('#ly=@@');
    assert.equal(junk.layers, undefined, 'a code without a single known letter is dropped, not "all off"');
    assert.deepEqual(junk.invalid, ['ly']);
    const none = parseHash('#ly=').layers;
    assert.ok(Object.values(none).every((v) => v === false), 'empty = everything off');
    const p = parseHash('#ly=bC').layers;
    assert.equal(p.beams, true);
    assert.equal(p.constellationNames, true);
    assert.equal(p.constellations, false);
    assert.equal(Object.values(p).filter(Boolean).length, 2);
    assert.equal(layersToCode(p), 'bC');
    const all = Object.fromEntries(LAYER_KEYS.map((k) => [k, true]));
    assert.equal(layersToCode(all), LAYER_CODES.map(([c]) => c).join(''));
});

test('names: decoded, + as space, control characters stripped, capped at 80', () => {
    assert.equal(parseHash('#loc=1,2&n=Ho+Chi+Minh+City').observer.name, 'Ho Chi Minh City');
    assert.equal(parseHash('#loc=1,2&n=S%C3%A3o%20Paulo').observer.name, 'São Paulo');
    assert.equal(parseHash('#loc=1,2&n=a%00b%0Ac%09d').observer.name, 'a b c d');
    assert.equal(parseHash(`#loc=1,2&n=${'x'.repeat(300)}`).observer.name.length, 80);
    assert.equal(parseHash('#loc=1,2&n=%E2%80%A8evil').observer.name, 'evil', 'line separators are whitespace');
});

test('accepts "#…", "…", "?…" and whole URLs; first occurrence of a key wins', () => {
    assert.equal(parseHash('sel=mars').selection, 'mars');
    assert.equal(parseHash('?sel=mars').selection, 'mars');
    assert.equal(parseHash('https://anshler.github.io/planet-location-marker/?x=1#sel=mars&q=low').quality, 'low');
    assert.equal(parseHash('#q=max').quality, 'max', 'max is a deep-linkable choice');
    const maxState = { ...DEFAULT_STATE, quality: { setting: 'max', active: 'max', ceiling: 'high' } };
    assert.match(serializeHash({ state: maxState, clock: { tMs: 0, rate: 1, playing: true, live: true } }), /(^#|&)q=max(&|$)/);
    assert.equal(parseHash('#q=ultra').quality, undefined);
    assert.equal(parseHash('#sel=mars&sel=venus').selection, 'mars');
    assert.equal(parseHash('#sel=none').selection, null);
    assert.equal(parseHash('#sel=MARS').selection, 'mars');
    assert.equal(parseHash('#debug').debug, true, 'bare flag');
});

test('fuzz: 1500 random hashes never throw and always validate', () => {
    const rand = rng(20261011);
    const pieces = ['#', '&', '=', '%', '%2', '%E0%A4%A', '%ZZ', '+', ',', '|', ':', '.', '-', '0', '1', '9', '90', '181', 'e', 'E',
        'loc', 'n', 'cc', 'tz', 'el', 't', 'r', 'p', 'view', 'lock', 'sel', 'ly', 'q', 'cam', 'intro', 'debug', 'o:', 's:',
        'Asia/Saigon', 'UTC', 'Etc/GMT-7', 'now', 'sky', 'orbit', 'mars', 'auto', 'bgoscC', '\u0000', '\uD800', '\uDFFF', '😀', 'ñ',
        ' ', '\n', '?', '/', '\\', '"', "'", '<script>', 'NaN', 'Infinity', '1e999', '-0', '2027-08-02T10:07:00Z', '0500-01-01',
        '%2B07:00', 'constructor', '__proto__', 'toString', 'loc=1,2', 't=2027', 'r=3600', 'cam=o:1,2,3',
        'loc2', 'n2', 'tz2', 'map', 'm:', 'loc2=-33.9,18.4', 'view=map', 'cam=m:1,2,3'];
    for (let i = 0; i < 1000; i++) {
        let s = '';
        const len = Math.floor(rand() * 30);
        for (let j = 0; j < len; j++) s += pieces[Math.floor(rand() * pieces.length)];
        const out = parseHash(s);
        assertValid(out, JSON.stringify(s));
        const hash = serializeHash({
            state: { ...DEFAULT_STATE, ...(out.observer ? { observer: out.observer } : {}), ...(out.layers ? { layers: out.layers } : {}),
                ...(out.observer2 ? { observer2: out.observer2 } : {}) },
            clock: { tMs: out.tMs ?? MIN_MS, rate: out.rate ?? 1, playing: out.playing ?? true, live: out.live ?? true },
            cam: out.cam,
        });
        assert.equal(typeof hash, 'string');
        assertValid(parseHash(hash), `reparse of ${JSON.stringify(s)}`);
    }
    for (let i = 0; i < 500; i++) {
        let s = '';
        const len = Math.floor(rand() * 60);
        for (let j = 0; j < len; j++) s += String.fromCharCode(Math.floor(rand() * 0x10000));
        assertValid(parseHash(s), 'random code units');
    }
    for (const x of [null, undefined, 42, {}, [], () => {}, Symbol('x'), 'x'.repeat(100000)]) assertValid(parseHash(x), String(typeof x));
});

test('serializeHash tolerates garbage', () => {
    for (const args of [
        { state: null }, { state: { observer: { latDeg: 'a' } } }, { state: { observer: { latDeg: 99, lonDeg: 0 } } },
        { clock: { tMs: Number.NaN, rate: 'x', playing: 'yes', live: false } }, { cam: 'nonsense' }, { cam: { mode: 'sky' } },
        { state: { layers: 'all', selection: 'pluto', quality: { setting: 'ultra' }, view: 7 } },
    ]) {
        const h = serializeHash(args);
        assert.equal(typeof h, 'string');
        assertValid(parseHash(h), JSON.stringify(args));
    }
    const getterBomb = { get observer() { throw new Error('boom'); } };
    assert.equal(serializeHash({ state: getterBomb }), '');
});

/** A minimal browser-global stand-in for bindUrl. */
function fakeWin(hash = '') {
    const listeners = new Map();
    const win = {
        calls: [],
        location: { hash, pathname: '/planet-location-marker/', search: '' },
        history: {
            state: null,
            replaceState(state, title, url) {
                win.calls.push(url);
                const i = url.indexOf('#');
                win.location.hash = i >= 0 ? url.slice(i) : '';
            },
        },
        addEventListener(type, fn) { listeners.set(type, fn); },
        removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
        fire(type) { listeners.get(type)?.(); },
        listeners,
    };
    return win;
}

test('bindUrl: nothing written until something changes; writes are throttled to 500 ms', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
    const win = fakeWin('#loc=51.4769,-0.0005');
    const store = createStore();
    const clock = createClock({ now: () => Date.now() });
    const off = bindUrl({ win, store, clock });
    t.mock.timers.tick(3000);
    assert.deepEqual(win.calls, [], 'no write at bind or while unchanged');

    store.set({ selection: 'mars' });
    store.set({ view: { mode: 'sky' } });
    t.mock.timers.tick(1);
    assert.equal(win.calls.length, 1, 'two quick changes, one write');
    assert.match(win.calls[0], /sel=mars/);
    assert.match(win.calls[0], /view=sky/);

    store.set({ selection: 'venus' });
    t.mock.timers.tick(300);
    assert.equal(win.calls.length, 1, 'still inside the 500 ms window');
    t.mock.timers.tick(250);
    assert.equal(win.calls.length, 2);
    assert.match(win.calls[1], /sel=venus/);

    clock.pause();
    t.mock.timers.tick(600);
    assert.equal(win.calls.length, 3, 'clock changes are written too');
    assert.match(win.calls[2], /&t=.*&p=0/);

    off();
    store.set({ selection: 'moon' });
    t.mock.timers.tick(5000);
    assert.equal(win.calls.length, 3, 'unbound');
    assert.equal(win.listeners.size, 0, 'hashchange listener removed');
    off();
});

test('bindUrl: running time and camera moves are picked up by the poll', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 5_000_000 });
    const win = fakeWin('');
    const store = createStore();
    let cam = { mode: 'orbit', latDeg: 10, lonDeg: 20, distance: 3 };
    const off = bindUrl({ win, store, clock: null, getCam: () => cam });
    t.mock.timers.tick(2000);
    assert.equal(win.calls.length, 0);
    cam = { mode: 'orbit', latDeg: 11, lonDeg: 20, distance: 3 };
    t.mock.timers.tick(1100);
    assert.equal(win.calls.length, 1);
    assert.match(win.calls[0], /cam=o:11,20,3$/);
    off();
});

test('bindUrl: hashchange reports the parsed link; debug=1 is preserved; history errors are survivable', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 9_000_000 });
    const win = fakeWin('#debug=1');
    const store = createStore();
    const seen = [];
    let fail = true;
    const realReplace = win.history.replaceState;
    win.history.replaceState = (...args) => {
        if (fail) throw new Error('SecurityError: too many calls');
        return realReplace(...args);
    };
    const off = bindUrl({ win, store, clock: null, onExternalChange: (p) => seen.push(p) });
    store.set({ selection: 'jupiter' });
    t.mock.timers.tick(10);
    assert.equal(win.calls.length, 0, 'the throwing write was swallowed');
    fail = false;
    t.mock.timers.tick(1100);
    assert.equal(win.calls.length, 1, 'the poll retried');
    assert.match(win.calls[0], /sel=jupiter.*&debug=1$/);

    win.location.hash = '#loc=10,20&sel=mars';
    win.fire('hashchange');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].observer.latDeg, 10);
    assert.equal(seen[0].selection, 'mars');
    win.fire('hashchange');
    assert.equal(seen.length, 1, 'the same hash is not reported twice');
    off();
});

test('bindUrl: missing pieces are tolerated', () => {
    assert.equal(typeof bindUrl(), 'function');
    assert.equal(typeof bindUrl({ win: {} }), 'function');
    assert.equal(typeof bindUrl({ win: { history: {}, location: {} } }), 'function');
});

test('sky=: the Sky darkness setting round-trips; auto is implicit; anything else is invalid', () => {
    assert.equal(parseHash('#sky=7').skyDark, '7');
    assert.equal(parseHash('#sky=Pristine').skyDark, 'pristine');
    assert.equal(parseHash('#sky=auto').skyDark, 'auto');
    const bad = parseHash('#sky=10');
    assert.equal(bad.skyDark, undefined);
    assert.deepEqual(bad.invalid, ['sky']);
    const state = (v) => ({ ...DEFAULT_STATE, display: { ...DEFAULT_STATE.display, skyDark: v } });
    assert.equal(serializeHash({ state: state('auto') }).includes('sky='), false);
    assert.match(serializeHash({ state: state('3') }), /&sky=3(&|$)/);
    assert.equal(parseHash(serializeHash({ state: state('pristine') })).skyDark, 'pristine');
});

test('au=: the Aurora activity setting round-trips; typical is implicit; anything else is invalid', () => {
    assert.equal(parseHash('#au=storm').aurora, 'storm');
    assert.equal(parseHash('#au=Quiet').aurora, 'quiet');
    const bad = parseHash('#au=7');
    assert.equal(bad.aurora, undefined);
    assert.deepEqual(bad.invalid, ['au']);
    const state = (v) => ({ ...DEFAULT_STATE, display: { ...DEFAULT_STATE.display, aurora: v } });
    assert.equal(serializeHash({ state: state('typical') }).includes('au='), false);
    assert.match(serializeHash({ state: state('storm') }), /&au=storm(&|$)/);
    assert.equal(parseHash(serializeHash({ state: state('quiet') })).aurora, 'quiet');
});

test('trk: sky-view tracking round-trips (b = the selected body, s = the stars)', () => {
    assert.equal(parseHash('#trk=b').track, 'body');
    assert.equal(parseHash('#trk=S').track, 'stars');
    assert.equal(parseHash('#trk=0').track, undefined);
    assert.equal(parseHash('#trk=0').invalid, undefined);
    assert.deepEqual(parseHash('#trk=x').invalid, ['trk']);
    const view = (track) => ({ state: { view: { mode: 'sky', earthLock: true, track } } });
    assert.equal(serializeHash(view('body')), '#view=sky&trk=b');
    assert.equal(serializeHash(view('stars')), '#view=sky&trk=s');
    assert.equal(serializeHash(view('none')), '#view=sky');
    for (const t of ['body', 'stars']) assert.equal(parseHash(serializeHash(view(t))).track, t);
});

test('vt: vantage points round-trip in globe view (l1, moon); none and sky view write nothing', () => {
    assert.equal(parseHash('#vt=l1').vantage, 'l1');
    assert.equal(parseHash('#vt=MOON').vantage, 'moon');
    for (const v of ['none', '0', '']) {
        assert.equal(parseHash(`#vt=${v}`).vantage, undefined);
        assert.equal(parseHash(`#vt=${v}`).invalid, undefined);
    }
    assert.deepEqual(parseHash('#vt=mars').invalid, ['vt']);
    const st = (mode, vantage) => ({ state: { view: { mode, earthLock: true, track: 'none', vantage } } });
    assert.equal(serializeHash(st('orbit', 'l1')), '#vt=l1');
    assert.equal(serializeHash(st('orbit', 'moon')), '#vt=moon');
    assert.equal(serializeHash(st('orbit', 'none')), '');
    assert.equal(serializeHash(st('sky', 'moon')), '#view=sky');
    for (const v of ['l1', 'moon']) assert.equal(parseHash(serializeHash(st('orbit', v))).vantage, v);
    // The camera key keeps the orbit pose a vantage returns to.
    const h = serializeHash({ ...st('orbit', 'moon'), cam: { mode: 'orbit', latDeg: 10, lonDeg: 20, distance: 3.4 } });
    assert.deepEqual(parseHash(h).cam, { mode: 'orbit', latDeg: 10, lonDeg: 20, distance: 3.4 });
});

test('view=map: the flat world map round-trips with its m: camera; a vantage is never written with it', () => {
    assert.equal(parseHash('#view=map').view, 'map');
    assert.equal(parseHash('#view=MAP').view, 'map');
    assert.deepEqual(parseHash('#view=maps').invalid, ['view']);
    const st = { view: { mode: 'map', earthLock: true, track: 'none', vantage: 'l1' } };
    const h = serializeHash({ state: st, cam: { mode: 'map', latDeg: 12.345, lonDeg: -200, distance: 2.5 } });
    assert.equal(h, '#view=map&cam=m:12.35,160,2.5');
    const p = parseHash(h);
    assert.equal(p.view, 'map');
    assert.deepEqual(p.cam, { mode: 'map', latDeg: 12.35, lonDeg: 160, distance: 2.5 });
    // Clamped like every camera; the view's own part is picked from a pair.
    assert.deepEqual(parseHash('#cam=m:95,10,999').cam, { mode: 'map', latDeg: 90, lonDeg: 10, distance: 20 });
    assert.equal(parseHash('#view=map&cam=o:1,2,3|m:4,5,6').cam.mode, 'map');
    assert.equal(camToCode({ mode: 'm', lat: 1, lon: 2, dist: 0.0001 }), 'm:1,2,0.05');
});

test('loc2: a second place round-trips (name, zone); bad values are reported, never applied', () => {
    const p = parseHash('#loc=52.52,13.4&n=Berlin&loc2=-33.9249,18.4241&n2=Cape+Town&tz2=Africa/Johannesburg');
    assert.deepEqual(p.observer2, {
        latDeg: -33.9249, lonDeg: 18.4241, elevM: 0, name: 'Cape Town', country: '', cc: '', tz: 'Africa/Johannesburg',
        tzApprox: false, source: 'url',
    });
    assert.equal(p.invalid, undefined);
    const h = serializeHash({ state: { observer: p.observer, observer2: p.observer2 } });
    assert.match(h, /&loc2=-33\.9249,18\.4241&n2=Cape%20Town&tz2=Africa\/Johannesburg/);
    assert.deepEqual(parseHash(h).observer2, p.observer2);
    assert.deepEqual(parseHash('#loc2=95,10').invalid, ['loc2']);
    assert.equal(parseHash('#loc2=95,10').observer2, undefined);
    assert.deepEqual(parseHash('#loc2=10,20&tz2=Mars/Olympus').invalid, ['tz2']);
    assert.equal(parseHash('#loc2=10,200').observer2.lonDeg, -160);
    // Nothing is written without a second place.
    assert.equal(serializeHash({ state: { observer2: null } }), '');
});

test('sel= round-trips extra objects (namespaced ids) and rejects malformed ones', () => {
    assert.equal(parseHash('#sel=comet:halley').selection, 'comet:halley');
    assert.equal(parseHash('#sel=Craft:Voyager1').selection, 'craft:voyager1');
    assert.equal(parseHash('#sel=guest:sn1054').selection, 'guest:sn1054');
    assert.equal(parseHash('#sel=star:32349').selection, 'star:32349');
    assert.equal(parseHash('#sel=dso:m31').selection, 'dso:m31');
    for (const bad of ['comet:', 'planet:x', 'comet:hal ley', 'comet:-x', `comet:${'a'.repeat(33)}`, 'craft:v1:x']) {
        const p = parseHash(`#sel=${encodeURIComponent(bad)}`);
        assert.equal(p.selection, undefined, bad);
        assert.ok(p.invalid.includes('sel'), bad);
    }
    const state = { observer: { latDeg: 50.9, lonDeg: 0.5, elevM: 0, name: '', country: '', tz: null, tzApprox: true, source: 'url' },
        selection: 'comet:halley', view: { mode: 'sky', earthLock: true }, layers: null };
    const hash = serializeHash({ state, clock: { live: true } });
    assert.match(hash, /(^|&)sel=comet:halley(&|$)/);
    assert.equal(parseHash(hash).selection, 'comet:halley');
});

test('a single cam= without view= names the view; view= wins when both are given', () => {
    assert.equal(parseHash('#cam=o:20,-130,7').view, 'orbit');
    assert.equal(parseHash('#cam=s:180,20,60').view, 'sky');
    assert.equal(parseHash('#cam=m:10,20,2').view, 'map');
    const both = parseHash('#view=sky&cam=o:20,-130,7|s:180,20,60');
    assert.equal(both.view, 'sky');
    assert.equal(both.cam.mode, 'sky');
    // A pair without view= is the app's own orbit link: no view is implied.
    assert.equal(parseHash('#cam=o:20,-130,7|s:180,20,60').view, undefined);
});
