// The status stack's bookkeeping (js/ui/modes.js createModeStack): chips in activation order, Esc
// leaves the newest first, the exposure's guard asks twice, and the flash sits after the chips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createModeStack } from '../js/ui/modes.js';
import { tpl } from '../js/ui/dom.js';

test('modes: activation order, the newest on top; an update keeps its place; Esc unwinds newest first', () => {
    const left = [];
    const m = createModeStack();
    const chip = (id, extra) => ({ title: id, exit: { label: 'Exit', done: `${id} off`, run: () => { left.push(id); m.clear(id); } }, ...extra });
    assert.equal(m.top(), null);
    assert.equal(m.exitTop(), null, 'nothing to leave: Esc deselects');
    assert.equal(m.set('scope', chip('scope')), true, 'new');
    m.set('ruler', chip('ruler'));
    m.set('loop', chip('loop'));
    assert.equal(m.set('scope', { detail: '0.5° field' }), false, 'an update');
    assert.deepEqual(m.ids(), ['scope', 'ruler', 'loop']);
    assert.equal(m.get('scope').detail, '0.5° field');
    assert.equal(m.get('scope').title, 'scope', 'updates merge');
    assert.deepEqual(m.exitTop(), { id: 'loop', done: 'loop off' });
    m.clear('ruler');   // left by its own button
    assert.deepEqual(m.exitTop(), { id: 'scope', done: 'scope off' });
    assert.deepEqual(left, ['loop', 'scope']);
    assert.equal(m.top(), null);
});

test('modes: the exposure guard warns on the first Esc and stops on a second within 3 s', () => {
    let t = 0;
    let frames = 0;
    let stopped = 0;
    const m = createModeStack({ now: () => t });
    m.set('expose', {
        title: 'Long exposure', exit: { label: 'Stop', run: () => { stopped += 1; } },
        guard: () => (frames > 0 ? 'Press Esc again to stop the exposure, or choose Save image' : null),
    });
    // No frames yet: it stops at once.
    assert.equal(m.exitTop().warn, undefined);
    assert.equal(stopped, 1);
    frames = 12;
    assert.match(m.exitTop().warn, /Press Esc again/);
    assert.equal(stopped, 1, 'warned, not stopped');
    t = 2000;
    assert.equal(m.exitTop().warn, undefined);
    assert.equal(stopped, 2, 'the second Esc stops it');
    // Too slow: the second press warns again.
    m.exitTop();
    t = 6000;
    assert.ok(m.exitTop().warn);
    assert.equal(stopped, 2);
    // A newer chip on top takes the Esc; the guard is not spent on it.
    m.set('follow', { title: 'Following', exit: { run: () => m.clear('follow') } });
    assert.equal(m.exitTop().id, 'follow');
    assert.ok(m.exitTop().warn, 'the exposure asks again');
});

test('modes: the flash is the stack\'s last child, so it never covers a chip; ui.flash stays its alias', async () => {
    const src = await readFile(new URL('../js/ui/modes.js', import.meta.url), 'utf8');
    assert.match(src, /insertBefore\(d\.root, flashEl\)/, 'chips are inserted before the flash');
    assert.match(src, /ui\.flash = flash/);
    assert.match(src, /role: 'region', 'aria-label': 'Active modes'/);
    assert.match(src, /class: 'flash', 'aria-hidden': 'true'/);
});

test('tpl: whole-phrase templates filled with text or nodes', () => {
    const made = [];
    const frag = () => ({ childNodes: [], appendChild(n) { this.childNodes.push(n); return n; } });
    globalThis.document = {
        createDocumentFragment: frag,
        createTextNode: (t) => { made.push(t); return { text: t }; },
    };
    const stubNode = !globalThis.Node;
    if (stubNode) globalThis.Node = class {};
    try {
        const f = tpl('Tip: press {keys} to select a body and {v} for Sky view.', { keys: '1–9', v: 'V' });
        assert.deepEqual(f.childNodes.map((n) => n.text), ['Tip: press ', '1–9', ' to select a body and ', 'V', ' for Sky view.']);
        assert.deepEqual(tpl('{missing} stays visible').childNodes.map((n) => n.text), ['{missing}', ' stays visible']);
    } finally {
        delete globalThis.document;
        if (stubNode) delete globalThis.Node;
    }
    assert.ok(made.length > 0);
});
