// Tests for js/ui/layers.js — the Display tab's layer list (UI-REDESIGN §4.11): every layer says
// where it is drawn, each view lists every layer exactly once, and the names match the
// announcements and the help table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYER_GROUPS, layersFor, BORTLE_NAMES } from '../js/ui/layers.js';
import { LAYER_CODES } from '../js/core/url-state.js';
import { LAYER_LABELS } from '../js/app/actions.js';
import { DEFAULT_STATE } from '../js/core/store.js';
import { SHORTCUTS } from '../js/ui/help.js';

const items = LAYER_GROUPS.flatMap((g) => g.items);
const keys = items.map((it) => it[0]);

test('every layer has a where, and none is listed twice', () => {
    for (const [key, label, , , where] of items) {
        assert.ok(['globe', 'sky', 'both'].includes(where), `${key}: ${where}`);
        assert.ok(label, key);
    }
    assert.equal(new Set(keys).size, keys.length);
});

test('every layer in the links and the defaults has a switch, and only those', () => {
    const codes = LAYER_CODES.map(([, key]) => key);
    assert.deepEqual([...keys].sort(), [...codes].sort());
    assert.deepEqual([...keys].sort(), Object.keys(DEFAULT_STATE.layers).sort());
    assert.equal(keys.length, 25);
});

test('layersFor: a view lists its own layers and puts the other view\'s in one group, each once', () => {
    for (const view of ['globe', 'sky']) {
        const { groups, other } = layersFor(view);
        const listed = groups.flatMap(([, ks]) => ks);
        assert.deepEqual([...listed, ...other].sort(), [...keys].sort(), view);
        const whereOf = Object.fromEntries(items.map((it) => [it[0], it[4]]));
        for (const k of listed) assert.ok(whereOf[k] === 'both' || whereOf[k] === view, `${view} lists ${k}`);
        for (const k of other) assert.ok(whereOf[k] !== 'both' && whereOf[k] !== view, `${view} hides ${k}`);
        assert.deepEqual(groups.map(([t]) => t), LAYER_GROUPS.map((g) => g.title), 'groups keep their order');
    }
    assert.deepEqual(layersFor('sky').other, ['beams', 'ghostBeams', 'sunMoonBeams', 'clouds', 'atmosphere', 'horizon', 'footprint', 'subpoints']);
    assert.deepEqual(layersFor('globe').other, ['altAzGrid', 'landscape', 'meteors']);
});

test('one name per layer: Display, the announcements and the help table agree', () => {
    for (const [key, label, k] of items) {
        assert.equal(LAYER_LABELS[key], label, key);
        if (!k) continue;
        const row = SHORTCUTS.find((g) => g.title === 'Layers').rows.find(([spec]) => spec === k.join('+'));
        assert.equal(row?.[1], label, `help row for ${key}`);
    }
});

test('Bortle names: classes 1 to 9', () => {
    assert.equal(BORTLE_NAMES.length, 9);
    assert.equal(BORTLE_NAMES[7], 'City sky');
});
