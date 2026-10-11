// Hygiene checks for the G2 pure modules (js/core, js/geo): purity rule R1, documentation, and
// import-time behaviour. Complements the repo-wide purity test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const FILES = [
    ...['types', 'store', 'bus', 'clock', 'url-state', 'quality', 'prefs', 'tz', 'format'].map((n) => `js/core/${n}.js`),
    ...['cities', 'geocode', 'coords'].map((n) => `js/geo/${n}.js`),
];
const source = (f) => readFileSync(new URL(f, ROOT), 'utf8');

test('every G2 module exists', () => {
    const core = readdirSync(new URL('js/core/', ROOT));
    const geo = readdirSync(new URL('js/geo/', ROOT));
    for (const f of FILES) assert.ok((f.startsWith('js/core/') ? core : geo).includes(f.split('/').pop()), f);
});

test('R1: no DOM, no browser globals, no three.js, astronomy-engine only via ae.js', () => {
    for (const f of FILES) {
        const s = source(f);
        assert.doesNotMatch(s, /\bwindow\b/i, `${f}: window`);
        assert.doesNotMatch(s, /\bdocument\b/i, `${f}: document`);
        assert.doesNotMatch(s, /from\s+['"]three/, `${f}: three`);
        assert.doesNotMatch(s, /vendor\/astronomy-engine/, `${f}: astronomy-engine must go through js/astro/ae.js`);
        assert.doesNotMatch(s, /\bnavigator\b|\bsessionStorage\b|\bindexedDB\b/, `${f}: browser globals`);
        if (!f.endsWith('prefs.js')) assert.doesNotMatch(s, /localStorage/, `${f}: only prefs.js may touch localStorage`);
        for (const m of s.matchAll(/from\s+['"]([^'"]+)['"]/g)) assert.ok(m[1].startsWith('./') || m[1].startsWith('../'), `${f}: relative imports only (${m[1]})`);
    }
});

test('R4: only geocode.js names external hosts', () => {
    for (const f of FILES) {
        if (f.endsWith('geocode.js')) continue;
        assert.doesNotMatch(source(f).replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, ''), /https?:\/\//, `${f}: external URL in code`);
    }
});

test('sources contain no raw line/paragraph separators or BOM', () => {
    const bad = [0x2028, 0x2029, 0xfeff].map((c) => String.fromCharCode(c));
    for (const f of FILES) {
        const s = source(f);
        for (const ch of bad) assert.ok(!s.includes(ch), `${f}: U+${ch.charCodeAt(0).toString(16).toUpperCase()}`);
    }
});

test('every export is documented with JSDoc', () => {
    for (const f of FILES) {
        const lines = source(f).split('\n');
        lines.forEach((line, i) => {
            if (!/^export\s+(async\s+)?(function|const|let|class)\b/.test(line)) return;
            let j = i - 1;
            while (j >= 0 && lines[j].trim() === '') j--;
            assert.match(lines[j] ?? '', /\*\/\s*$/, `${f}:${i + 1} ${line.slice(0, 60)}`);
        });
    }
});

test('modules import cleanly with no output and no side effects', async () => {
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    const printed = [];
    for (const k of Object.keys(original)) console[k] = (...a) => printed.push([k, ...a]);
    try {
        for (const f of FILES) {
            const mod = await import(new URL(f, ROOT));
            assert.ok(mod, f);
        }
    } finally {
        Object.assign(console, original);
    }
    assert.deepEqual(printed, []);
    const types = await import(new URL('js/core/types.js', ROOT));
    assert.deepEqual(Object.keys(types), [], 'types.js is JSDoc only');
});
