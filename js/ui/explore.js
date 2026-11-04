/**
 * Explore tab (UI-REDESIGN §4.10): guided tours (actions.startTour), the sky you were born under
 * (astro/sky-caption.js), Moments and Famous comets (core/moments.js hash links; a few, then 'Show
 * all'), a second place (actions.compareWith) and Mars (the search's Mars mode). Tours and Mars need
 * the 3D view. A moment or 'Show my sky' lowers the phone sheet, so the sky shows.
 *
 * @module ui/explore
 */

import { TOURS } from '../core/tour-catalog.js';
import { MOMENTS, FAMOUS_COMETS } from '../core/moments.js';
import { skyCaption } from '../astro/sky-caption.js';
import { h, on, setText } from './dom.js';
import { icon } from './icons.js';

/**
 * Mounts the Explore tab.
 * @param {HTMLElement} root tab panel
 * @param {any} ctx UiCtx
 * @returns {{destroy(): void}}
 */
export function mountExplore(root, ctx) {
    const { ui, clock, store } = ctx;
    const offs = [];
    const lower = () => {
        const u = store.get().ui;
        if (u.sheet !== 'peek') store.set({ ui: { ...u, sheet: 'peek' } }, 'explore');
    };
    const group = (title, ...kids) => h('div', { class: 'group' }, h('h3', { class: 'group-title' }, title), ...kids);

    const tourBtns = TOURS.map((t) => h('button', {
        class: 'tour-card', type: 'button', 'data-tour': t.id, 'aria-pressed': 'false',
        'aria-label': `Play the guided tour ${t.title}: ${t.blurb}`,
    }, h('span', { class: 'tour-card__title' }, icon('play', { size: 14 }), t.title), h('span', { class: 'tour-card__blurb' }, t.blurb)));
    const tours = group('Guided tours', h('div', { class: 'tours', role: 'group', 'aria-label': 'Guided tours' }, tourBtns));

    const bornDate = h('input', { class: 'input', type: 'date', min: '1000-01-01', max: '2999-12-31', required: true, 'aria-label': 'Date of birth' });
    const bornTime = h('input', { class: 'input', type: 'time', value: '21:00', 'aria-label': 'Time (optional)' });
    const bornCaption = h('p', { class: 'born__caption', 'aria-live': 'polite', hidden: true });
    const bornForm = h('form', { class: 'born', novalidate: true },
        h('div', { class: 'born__row' },
            h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Date'), bornDate),
            h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Time'), bornTime),
            h('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, icon('sky', { size: 16 }), 'Show my sky')),
        bornCaption);

    /** The first `first` links of a history list, then 'Show all', which reveals the rest. */
    const history = (title, list, first, more, cls) => {
        const items = list.map((m, i) => h('div', { role: 'listitem', hidden: i >= first },
            h('a', { class: 'moment', href: m.hash, 'data-moment': m.id },
                h('span', { class: 'moment__title' }, m.title),
                h('span', { class: 'moment__when' }, m.when ?? m.detail),
                m.caption ? h('span', { class: 'moment__caption' }, m.caption) : null,
                m.sources ? h('span', { class: 'moment__src' }, m.sources.join(' · ')) : null)));
        const all = h('button', { class: 'btn btn--soft btn--sm moments__all', type: 'button' }, more);
        offs.push(on(all, 'click', () => {
            for (const it of items) it.hidden = false;
            all.remove();
            items[first]?.firstChild.focus();
        }));
        return group(`${title} · ${list.length}`, h('div', { class: cls, role: 'list', 'aria-label': title }, items), all);
    };

    // Other places: cards like the tours'.
    const card = (ic, title, detail) => {
        const t = h('span', null, title);
        const d = h('span', { class: 'tour-card__blurb' }, detail);
        return { el: h('button', { class: 'tour-card', type: 'button' }, h('span', { class: 'tour-card__title' }, icon(ic, { size: 16 }), t), d), t, d };
    };
    const two = card('compare', 'Two places at once', 'A second pin and its beams, compared in Up now');
    const twoName = h('span', { style: 'flex:1' });
    const twoChange = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Change');
    const twoRemove = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Remove');
    const twoOn = h('p', { class: 'btn-row note', style: 'align-items:center', hidden: true }, twoName, twoChange, twoRemove);
    const mars = card('planet', '', '');
    offs.push(on(two.el, 'click', () => ui.act('compareWith')));
    offs.push(on(twoChange, 'click', () => ui.act('compareWith')));
    offs.push(on(twoRemove, 'click', () => ui.act('setObserver2', null)));
    offs.push(on(mars.el, 'click', () => {
        const s = store.get();
        if (s.host?.id === 'mars') ui.act('leaveMars');
        else store.set({ ui: { ...s.ui, palette: 'mars' } });
    }));

    root.append(tours, group('The sky you were born under', h('p', { class: 'note' }, 'Your birthday, seen from where you are now.'), bornForm),
        history('Moments in history', MOMENTS, 4, `Show all ${MOMENTS.length} moments`, 'moments'),
        history('Famous comets', FAMOUS_COMETS, 3, `Show all ${FAMOUS_COMETS.length} comets`, 'moments moments--comets'),
        group('Other places', h('div', { class: 'tours' }, two.el, mars.el), twoOn),
        h('p', { class: 'note' }, 'Dates before 15 October 1582 are Julian, as the records give them. Positions before 1600 are less certain (ΔT); comet tails and supernova light curves are models.'));

    offs.push(on(root, 'click', (e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        const tb = t.closest('[data-tour]');
        if (tb) ui.act('startTour', tb.dataset.tour);
        // A moment closes the phone sheet to its peek, so the sky it opens is in view.
        else if (t.closest('[data-moment]')) lower();
    }));

    // 'The sky you were born under': that instant in Sky view, then a caption from the readout.
    let bornWait = null;
    offs.push(on(bornForm, 'submit', (e) => {
        e.preventDefault();
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bornDate.value || '');
        if (!m) { bornDate.setAttribute('aria-invalid', 'true'); bornDate.focus(); return; }
        bornDate.removeAttribute('aria-invalid');
        const tm = /^(\d{2}):(\d{2})/.exec(bornTime.value || '') || ['', '21', '00'];
        const ms = ui.toUtc({ y: +m[1], mo: +m[2], d: +m[3], h: +tm[1], mi: +tm[2], s: 0, cal: 'gregorian' });
        if (!Number.isFinite(ms)) return;
        clock.pause?.();
        clock.setTime?.(ms, { animateMs: 0 });
        ui.act('setViewMode', 'sky');
        lower();
        bornCaption.hidden = false;
        bornCaption.textContent = 'Reading the sky…';
        bornWait?.();
        const done = ui.on('snap', (snap) => {
            if (!snap || Math.abs(snap.tMs - ms) > 1000) return;
            done();
            bornWait = null;
            const text = skyCaption(snap);
            bornCaption.textContent = `${ui.fmtDay(ms)}, ${ui.fmtClock(ms)}: ${text}`;
            ctx.bus?.emit?.('announce', text);
        });
        bornWait = done;
    }));

    offs.push(store.subscribe((s) => s.ui.tour?.id ?? '', (id) => {
        for (const b of tourBtns) b.setAttribute('aria-pressed', String(b.dataset.tour === id));
    }, { immediate: true }));
    const sync = () => {
        const s = store.get();
        const gl = s.status?.webgl !== false;
        // startTour and standOnMars need the 3D view.
        tours.hidden = mars.el.hidden = !gl;
        const o2 = s.observer2;
        twoOn.hidden = !o2;
        if (o2) setText(twoName, `Comparing with ${ui.placeShort(o2)}`);
        const onMars = s.host?.id === 'mars';
        setText(mars.t, onMars ? 'Back to the Earth' : 'Stand on Mars');
        setText(mars.d, onMars ? 'Leave Mars for your place on the Earth' : 'The sky from a landing site, with the Earth as an evening star');
    };
    for (const sel of [(s) => s.status?.webgl, (s) => s.observer2, (s) => s.host?.id]) offs.push(store.subscribe(sel, sync));
    sync();

    return { destroy() { bornWait?.(); offs.forEach((off) => off()); root.textContent = ''; } };
}
