// The string tables match the source (docs/ARCHITECTURE.md §12 'Strings and locales'): every
// t('…'), tn('…', '…', n) and N_('…') literal across js/ is a key of data/i18n/vi.json (tn's key is
// its `other` form), with exactly the same {placeholders}; the table has no key the source no longer
// uses, no empty translation, and its keys stay sorted. Comments are ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanJs, lineAt } from '../scripts/lib/jsscan.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TABLES = ['data/i18n/vi.json'];

function jsFiles(dir) {
    return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) return e.name === 'graphify-out' ? [] : jsFiles(rel);
        return /\.m?js$/.test(e.name) ? [rel] : [];
    });
}

/** The string literal starting at src[i] ('…', "…", `…`): {value, end}, or null (a template with ${}). */
function literalAt(src, i) {
    const q = src[i];
    if (q !== "'" && q !== '"' && q !== '`') return null;
    let j = i + 1;
    while (j < src.length && src[j] !== q) {
        if (src[j] === '\\') j += 1;
        else if (q === '`' && src[j] === '$' && src[j + 1] === '{') return null;
        j += 1;
    }
    // eslint-disable-next-line no-new-func
    return { value: Function(`return ${src.slice(i, j + 1)}`)(), end: j + 1 };
}

const skipWs = (src, i) => { while (/\s/.test(src[i] ?? '')) i += 1; return i; };

/** Every marked string: {key, file, line, call}, plus the calls whose first argument is a template with ${}. */
function extract() {
    const keys = [];
    const dynamic = [];
    for (const file of jsFiles('js')) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const { noComments, code } = scanJs(src);
        for (const m of noComments.matchAll(/(?<![\w$.])(tn|t|N_)\(/g)) {
            if (code[m.index] !== m[1][0]) continue;   // inside a string
            const line = lineAt(src, m.index);
            const a = skipWs(noComments, m.index + m[0].length);
            if (noComments[a] === '`' && !literalAt(noComments, a)) { dynamic.push(`${file}:${line}`); continue; }
            const first = literalAt(noComments, a);
            if (!first) continue;   // t(label): a table's string, marked with N_ where it is defined
            let key = first.value;
            if (m[1] === 'tn') {
                const c = skipWs(noComments, first.end);
                const second = noComments[c] === ',' ? literalAt(noComments, skipWs(noComments, c + 1)) : null;
                if (!second) { dynamic.push(`${file}:${line}`); continue; }
                key = second.value;
            }
            keys.push({ key, file, line, call: m[1] });
        }
    }
    return { keys, dynamic };
}

/** Files that import t from core/i18n.js and also bind a local `t` (which would shadow it, or throw in its TDZ). */
function shadows() {
    const bad = [];
    for (const file of jsFiles('js')) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const { code } = scanJs(src);
        if (!/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*'[^']*core\/i18n\.js'/.test(scanJs(src).noComments)) continue;
        const res = [/\b(?:const|let|var)\s+t\b/g, /(?<![\w$.])t\s*=>/g, /\(\s*t\s*(?:,[^()]*)?\)\s*=>/g, /\bfunction\b[^(]*\(([^)]*\bt\b[^)]*)\)/g,
            /\(([^()]*,\s*t)\s*\)\s*=>/g, /\[\s*t\s*[,\]]|,\s*t\s*\]\s*=/g];
        for (const re of res) for (const m of code.matchAll(re)) {
            if (re.source.startsWith('\\bfunction') && !/(^|[\s,(])t\s*(=|,|$)/.test(m[1])) continue;
            bad.push(`${file}:${lineAt(src, m.index)}  ${m[0].trim()}`);
        }
    }
    return bad;
}

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const forms = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v) : [v]);
const { keys, dynamic } = extract();
const used = new Set(keys.map((k) => k.key));

test('i18n: the source has marked strings, and none is built from a template', () => {
    assert.ok(keys.length >= 50, `found ${keys.length} marked strings`);
    assert.deepEqual(dynamic, [], 't(`…${x}…`) cannot be translated: use a {placeholder}');
});

test('i18n: no module that imports t also names a local t', () => {
    assert.deepEqual(shadows(), []);
});

for (const rel of TABLES) {
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const table = JSON.parse(raw);

    test(`${rel}: a flat object of non-empty strings (or plural forms), keys sorted`, () => {
        assert.equal(typeof table, 'object');
        assert.ok(table && !Array.isArray(table));
        const bad = Object.entries(table).filter(([, v]) => !forms(v).length || forms(v).some((f) => typeof f !== 'string' || !f.trim()));
        assert.deepEqual(bad.map(([k]) => k), [], 'empty or non-string translations');
        const names = Object.keys(table);
        assert.deepEqual(names, [...names].sort(), 'keys are sorted (code-unit order)');
    });

    test(`${rel}: every marked string has a translation`, () => {
        const missing = [...new Map(keys.filter((k) => !Object.hasOwn(table, k.key)).map((k) => [k.key, `${k.file}:${k.line}  ${JSON.stringify(k.key)}`])).values()];
        assert.deepEqual(missing, []);
    });

    test(`${rel}: placeholders match the English exactly`, () => {
        const bad = Object.entries(table).flatMap(([k, v]) => forms(v)
            .filter((f) => placeholders(f).join() !== placeholders(k).join())
            .map((f) => `${JSON.stringify(k)} → ${JSON.stringify(f)}`));
        assert.deepEqual(bad, []);
    });

    test(`${rel}: no key the source no longer uses`, () => {
        assert.deepEqual(Object.keys(table).filter((k) => !used.has(k)), []);
    });
}

test('index.html: the inline loader has Vietnamese for every stage label, tip and message it shows', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const block = html.slice(html.indexOf('VI = {'), html.indexOf('};', html.indexOf('VI = {')));
    const vi = new Map([...block.matchAll(/'((?:[^'\\]|\\.)*)': '((?:[^'\\]|\\.)*)'/g)].map((m) => [m[1], m[2]]));
    assert.ok(vi.size >= 20, `found ${vi.size} loader strings`);
    const main = fs.readFileSync(path.join(ROOT, 'js/main.js'), 'utf8');
    const labels = [...main.matchAll(/loader\.progress\(([^;]*)\);/g)].flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
    const tipsSrc = html.slice(html.indexOf('var tips = '), html.indexOf('var tipEl'));
    const tips = [...tipsSrc.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
    assert.ok(labels.length >= 5 && tips.length >= 10);
    const missing = [...labels, ...tips, 'Loading', 'Reload', 'Details'].filter((s) => !vi.has(s));
    assert.deepEqual(missing, []);
    for (const [en, tr] of vi) assert.deepEqual(placeholders(tr), placeholders(en), en);
});
