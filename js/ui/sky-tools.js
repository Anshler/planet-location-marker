/**
 * Sky-view tools in the view switch (ROADMAP angle-ruler-and-fists, ar-sky-pointing):
 *
 * - Ruler (A): measure the angle between two things in the sky. While it is on, a pill under the
 *   top bar says what to tap next and then reads 'Moon → Jupiter · 11.9° · about 1 fist at arm's
 *   length'; × (or Esc, or A) turns it off. The arc and its label are drawn by render/ruler.js.
 * - Point at the sky (phones with orientation sensors, https only): the view follows the phone. The
 *   pill says it is approximate and offers Align (centre a bright body, then tap) and Stop.
 *
 * Both are sky-view only and hidden in text mode. State: `ui.ruler`, `ui.aim` (actions.setRuler,
 * actions.pointAtSky, actions.alignAim).
 *
 * @module ui/sky-tools
 */

import { h, on, setAttr, setText } from './dom.js';
import { icon } from './icons.js';

/** True where 'Point at the sky' can work: orientation events, a secure page, a touch screen. */
export function canPointAtSky(win, coarse) {
    try {
        return !!coarse && !!win && 'DeviceOrientationEvent' in win && win.isSecureContext !== false;
    } catch {
        return false;
    }
}

/**
 * Mounts the tools: two buttons for the view switch and their status pills.
 * @param {HTMLElement} host overlay host (`ui.root`)
 * @param {any} ctx UiCtx
 * @returns {{rulerBtn:HTMLElement, pointBtn:HTMLElement, destroy():void}}
 */
export function mountSkyTools(host, ctx) {
    const { store, ui } = ctx;
    const offs = [];
    const coarse = !!(ctx.env?.coarse ?? store.get().status?.coarse);
    const pointable = canPointAtSky(typeof window !== 'undefined' ? window : null, coarse);

    const rulerBtn = h('button', {
        class: 'icon-btn icon-btn--glass glass vb-ruler', type: 'button', 'aria-pressed': 'false',
        'aria-label': 'Measure an angle in the sky', 'data-tip': 'Measure an angle', 'data-kbd': 'A',
    }, icon('ruler', { size: 19 }));
    const pointBtn = h('button', {
        class: 'icon-btn icon-btn--glass glass vb-point', type: 'button', 'aria-pressed': 'false',
        'aria-label': 'Point the phone at the sky', 'data-tip': 'Point at the sky',
    }, icon('phone', { size: 19 }));

    // Pills: the ruler's reading and the pointing status, stacked under the top bar.
    const rName = h('span', { class: 'stool__name' });
    const rDetail = h('span', { class: 'stool__detail' });
    const rClose = h('button', { class: 'icon-btn stool__x', type: 'button', 'aria-label': 'Close the ruler (Esc)', title: 'Close the ruler (Esc)' },
        icon('close', { size: 16 }));
    const rulerPill = h('div', { class: 'stool stool--ruler glass', role: 'status', hidden: true },
        h('span', { class: 'stool__icon', 'aria-hidden': 'true' }, icon('ruler', { size: 18 })),
        h('span', { class: 'stool__text' }, rName, rDetail), rClose);
    const aName = h('span', { class: 'stool__name' });
    const aDetail = h('span', { class: 'stool__detail' });
    const alignBtn = h('button', { class: 'btn btn--soft stool__btn', type: 'button', title: 'Centre the Moon, a bright planet or a bright star in the real sky, then tap' },
        icon('target', { size: 15 }), h('span', null, 'Align'));
    const stopBtn = h('button', { class: 'btn btn--soft stool__btn', type: 'button' }, h('span', null, 'Stop'));
    const aimPill = h('div', { class: 'stool stool--aim glass', role: 'status', hidden: true },
        h('span', { class: 'stool__icon', 'aria-hidden': 'true' }, icon('phone', { size: 18 })),
        h('span', { class: 'stool__text' }, aName, aDetail), alignBtn, stopBtn);
    const stack = h('div', { class: 'stools' }, aimPill, rulerPill);
    host.appendChild(stack);

    offs.push(on(rulerBtn, 'click', () => ui.act('setRuler')));
    offs.push(on(rClose, 'click', () => ui.act('setRuler', false)));
    // Inside the tap: iOS shows its motion-permission prompt only from a user gesture.
    offs.push(on(pointBtn, 'click', () => ui.act('pointAtSky')));
    offs.push(on(stopBtn, 'click', () => ui.act('pointAtSky', false)));
    offs.push(on(alignBtn, 'click', () => ui.act('alignAim')));

    function sync() {
        const st = store.get();
        const sky = st.view?.mode === 'sky';
        const gl = st.status?.webgl !== false;
        const r = st.ui?.ruler ?? null;
        const a = st.ui?.aim ?? null;
        rulerBtn.hidden = !sky || !gl;
        setAttr(rulerBtn, 'aria-pressed', String(!!r));
        rulerBtn.classList.toggle('is-on', !!r);
        pointBtn.hidden = !sky || !gl || !pointable;
        setAttr(pointBtn, 'aria-pressed', String(!!a));
        pointBtn.classList.toggle('is-on', !!a);
        pointBtn.dataset.tip = a ? 'Stop following the phone' : 'Point at the sky';

        rulerPill.hidden = !r || !sky;
        if (r) {
            if (r.ends >= 2 && r.text) {
                setText(rName, `${cap(r.from)} → ${r.to}`);
                setText(rDetail, `${r.text} at arm’s length`);
            } else if (r.ends === 1) {
                setText(rName, `From ${r.from}`);
                setText(rDetail, 'Now tap a second point');
            } else {
                setText(rName, 'Ruler');
                setText(rDetail, 'Tap a body, a star or any point of the sky');
            }
        }
        aimPill.hidden = !a || !sky;
        if (a) {
            const starting = a.source === 'starting';
            setText(aName, starting ? 'Point at the sky' : 'Following the phone');
            setText(aDetail, starting ? 'Waiting for the compass…'
                : a.aligned ? `Aligned on ${a.aligned} · still approximate`
                    : a.source === 'relative' ? 'No compass here: centre a bright body and tap Align'
                        : 'Approximate (compass ±10°): centre a bright body, then Align');
            alignBtn.disabled = starting;
        }
    }
    offs.push(store.subscribe((s) => s.view, sync));
    offs.push(store.subscribe((s) => s.ui.ruler, sync));
    offs.push(store.subscribe((s) => s.ui.aim, sync));
    offs.push(store.subscribe((s) => s.status?.webgl, sync));
    sync();

    return {
        rulerBtn,
        pointBtn,
        destroy() {
            offs.forEach((off) => off());
            stack.remove();
        },
    };
}

function cap(s) {
    const t = String(s ?? '');
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}
