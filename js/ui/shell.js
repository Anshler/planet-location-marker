/**
 * Layout shell: builds the regions inside `#ui-root` and moves them between
 * three layouts without re-mounting anything (state and listeners survive):
 *
 * - **desktop** (≥ 900 px, unless coarse and < 1100 px): top-left wordmark + location
 *   chip, right 380-px glass panel (collapsible to a 64-px rail), bottom time bar
 *   spanning to the panel, view switch above the time bar's right end;
 * - **mobile**: top bar, floating right column, a tab bar (`nav.navbar`: the tablist, moved) and a
 *   bottom sheet above it (head: the handle and the time bar) with three snaps (peek, half, full),
 *   a 0.5 px/ms fling, an `aria-expanded` handle and, at full, a trap over the sheet and tab bar;
 * - **text** (`body.no-webgl`): a readable single-column document with Up now first.
 *
 * In every layout the status stack (ui/modes.js) follows the top bar, so its chips come after the
 * location chip in the Tab order. Tabs follow the WAI-ARIA tabs pattern (rovingKeys). `ui.openPanel(id,
 * {focus, sheet, reveal})` shows a tab; `reveal` opens, scrolls to, focuses and flashes a section.
 *
 * @module ui/shell
 */

import { h, on, trapFocus, clamp, focusables, rovingKeys } from './dom.js';
import { icon } from './icons.js';
import { mountTopbar } from './topbar.js';
import { mountTimebar } from './timebar.js';
import { mountViewSwitch } from './view-switch.js';
import { mountSkyNow } from './sky-now.js';
import { mountBodyCard } from './body-card.js';
import { mountEventsPanel } from './events-panel.js';
import { mountExplore } from './explore.js';
import { mountDisplay } from './layers.js';
import { mountLocation } from './location.js';
import { mountHelp } from './help.js';
import { mountEclipseHud } from './eclipse-hud.js';
import { mountTourBar } from './tour-bar.js';
import { mountModes } from './modes.js';

/** Panel tabs, in display order (store PANELS). */
export const TABS = [
    { id: 'sky', label: 'Up now', icon: 'star', title: 'What is in the sky now', mount: mountSkyNow },
    { id: 'details', label: 'Details', icon: 'target', title: 'The selected object', mount: mountBodyCard },
    { id: 'events', label: 'Events', icon: 'calendar', title: 'Upcoming events', mount: mountEventsPanel },
    { id: 'explore', label: 'Explore', icon: 'history', title: 'Tours, history and other places', mount: mountExplore },
    { id: 'display', label: 'Display', icon: 'layers', title: 'Layers and settings', mount: mountDisplay },
];

const SNAPS = ['peek', 'half', 'full'];
const FLING_PX_PER_MS = 0.5;
const MOBILE_QUERY = '(max-width: 899.98px), (pointer: coarse) and (max-width: 1099.98px)';

/**
 * Mounts the shell and every region module.
 * @param {HTMLElement} root `#ui-root`
 * @param {any} ctx UiCtx with `ctx.ui`
 * @returns {{update(snap:any): void, destroy(): void, overlay: HTMLElement}}
 */
export function mountShell(root, ctx) {
    const { store, ui } = ctx;
    const offs = [];
    const children = [];
    root.textContent = '';

    // ------------------------------------------------------------------ regions
    const skip = h('a', { class: 'skip-link', href: '#tp-sky' }, 'Skip to the sky list');
    offs.push(on(skip, 'click', (e) => { e.preventDefault(); openPanel('sky', { focus: true }); }));

    const topbarEl = h('header', { class: 'topbar' });
    const viewbarEl = h('div', { class: 'viewbar' });
    const timebarEl = h('section', { class: 'timebar glass', 'aria-label': 'Time controls' });
    const hudEl = h('section', { class: 'ecl glass' });
    const overlay = h('div', { class: 'ui-overlay' });

    // ------------------------------------------------------------------ panel + tabs
    const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Panels', 'aria-orientation': 'horizontal' });
    const ink = h('span', { class: 'tabs__ink', 'aria-hidden': 'true' });
    const collapseBtn = h('button', {
        class: 'icon-btn panel__collapse', type: 'button', 'aria-label': 'Collapse panel', 'aria-expanded': 'true',
        'data-tip': 'Collapse panel', 'data-tip-side': 'left',
    }, icon('panel-close', { size: 18 }));
    const body = h('div', { class: 'panel__body' });
    const panelHead = h('div', { class: 'panel__head' }, tablist, collapseBtn);
    const panelEl = h('aside', { class: 'panel glass', 'aria-label': 'Sky information' }, panelHead, body);
    // The phone's tab bar: the same tablist, moved (applyLayout).
    const nav = h('nav', { class: 'navbar', 'aria-label': 'Panels' });
    tablist.appendChild(ink);

    /** @type {Record<string, {tab: HTMLElement, pane: HTMLElement, mod: any}>} */
    const tabs = {};
    for (const t of TABS) {
        const tab = h('button', {
            class: 'tab', type: 'button', role: 'tab', id: `tab-${t.id}`, 'aria-controls': `tp-${t.id}`,
            'aria-selected': 'false', tabindex: '-1', 'data-tab': t.id, 'data-tip': t.title, 'data-tip-side': 'left',
        }, icon(t.icon, { size: 18 }), h('span', { class: 'tab__label' }, t.label));
        const pane = h('section', {
            class: `tabpanel tabpanel--${t.id}`, role: 'tabpanel', id: `tp-${t.id}`, 'aria-labelledby': `tab-${t.id}`,
            tabindex: '0', hidden: true,
        }, h('h2', { class: 'sr-only' }, t.label));
        tablist.appendChild(tab);
        body.appendChild(pane);
        tabs[t.id] = { tab, pane, mod: null };
    }

    // ------------------------------------------------------------------ sheet (mobile)
    const handle = h('button', {
        class: 'sheet__handle', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'sheet-body',
        'aria-label': 'Expand panel',
    }, h('span', { class: 'sheet__grip', 'aria-hidden': 'true' }));
    const sheetHead = h('div', { class: 'sheet__head' });
    const sheetBody = h('div', { class: 'sheet__body', id: 'sheet-body' });
    const sheet = h('section', { class: 'sheet', 'aria-label': 'Time and sky panel' }, handle, sheetHead, sheetBody);

    // ------------------------------------------------------------------ misc overlays
    const cinemaExit = h('button', { class: 'cinema-exit', type: 'button' }, icon('eye', { size: 18 }), 'Show interface');
    overlay.append(cinemaExit);

    // ------------------------------------------------------------------ mount modules
    // The status stack first: the modules below set their mode chips as they mount.
    const modes = mountModes(root, ctx);
    children.push(mountTopbar(topbarEl, ctx), modes);
    const timebar = mountTimebar(timebarEl, ctx);
    children.push(timebar);
    children.push(mountViewSwitch(viewbarEl, ctx));
    const hud = mountEclipseHud(hudEl, ctx);
    children.push(hud);
    for (const t of TABS) {
        tabs[t.id].mod = t.mount(tabs[t.id].pane, ctx);
        children.push(tabs[t.id].mod);
    }
    children.push(mountLocation(overlay, ctx));
    children.push(mountHelp(overlay, ctx));
    children.push(mountTourBar(overlay, ctx));

    // ------------------------------------------------------------------ tabs behaviour
    let activeTab = '';
    function selectTab(id, { focusTab = false } = {}) {
        if (!tabs[id]) id = 'sky';
        if (id !== activeTab) {
            for (const t of TABS) {
                const sel = t.id === id;
                tabs[t.id].tab.setAttribute('aria-selected', String(sel));
                tabs[t.id].tab.tabIndex = sel ? 0 : -1;
                tabs[t.id].tab.classList.toggle('is-active', sel);
                tabs[t.id].pane.hidden = !sel;
            }
            activeTab = id;
            const mod = tabs[id].mod;
            if (ui.snap) try { mod?.update?.(ui.snap); } catch (err) { console.error('[ui] tab update failed', err); }
            mod?.shown?.();
            // On phones the sheet's body is the scroller.
            tabs[id].pane.scrollTop = 0;
            body.scrollTop = 0;
            sheetBody.scrollTop = 0;
            placeInk();
        }
        if (focusTab) tabs[id].tab.focus();
    }
    function placeInk() {
        const t = tabs[activeTab]?.tab;
        if (!t || !t.offsetWidth) return;
        ink.style.width = `${t.offsetWidth}px`;
        ink.style.transform = `translateX(${t.offsetLeft}px)`;
    }
    offs.push(on(tablist, 'click', (e) => {
        const btn = /** @type {HTMLElement} */ (e.target).closest('[role="tab"]');
        if (!btn) return;
        openPanel(btn.dataset.tab);
    }));
    offs.push(rovingKeys(tablist, TABS.map((t) => tabs[t.id].tab), (tab) => {
        setStoreUi({ panel: tab.dataset.tab });
        selectTab(tab.dataset.tab, { focusTab: true });
        if (ui.layout === 'mobile' && currentSnap === 'peek') setSnap('half');
    }));

    // ------------------------------------------------------------------ rail (desktop)
    let railed = false;
    function setRail(on_) {
        railed = on_;
        panelEl.classList.toggle('is-rail', railed);
        tablist.setAttribute('aria-orientation', railed ? 'vertical' : 'horizontal');
        collapseBtn.setAttribute('aria-expanded', String(!railed));
        collapseBtn.setAttribute('aria-label', railed ? 'Expand panel' : 'Collapse panel');
        collapseBtn.dataset.tip = railed ? 'Expand panel' : 'Collapse panel';
        collapseBtn.replaceChildren(icon(railed ? 'panel-open' : 'panel-close', { size: 18 }));
        root.classList.toggle('has-rail', railed);
        requestAnimationFrame(placeInk);
    }
    offs.push(on(collapseBtn, 'click', () => setRail(!railed)));

    // ------------------------------------------------------------------ open a panel
    /**
     * Shows a tab, expanding the rail or raising the sheet as needed; `reveal` opens, scrolls to,
     * focuses and flashes one of its sections.
     * @param {string} id
     * @param {{focus?: boolean, sheet?: 'half'|'full', reveal?: string}} [opts]
     */
    function openPanel(id, { focus = false, sheet: sheetSnap, reveal } = {}) {
        setStoreUi({ panel: id });
        selectTab(id);
        if (ui.layout === 'desktop' && railed) setRail(false);
        if (ui.layout === 'mobile') {
            const want = sheetSnap || 'half';
            if (SNAPS.indexOf(currentSnap) < SNAPS.indexOf(want)) setSnap(want, { animate: true });
        }
        const pane = tabs[activeTab].pane;
        const sec = reveal && pane.querySelector(`[data-reveal="${reveal}"]`);
        if (sec) {
            sec.closest('details')?.setAttribute('open', '');
            requestAnimationFrame(() => {
                sec.scrollIntoView({ block: 'nearest' });
                (sec.querySelector('[data-autofocus]') || sec.querySelector('summary') || focusables(sec)[0])?.focus({ preventScroll: true });
                sec.classList.add('is-flash');
                setTimeout(() => sec.classList.remove('is-flash'), 1200);
            });
        } else if (focus) requestAnimationFrame(() => pane.focus({ preventScroll: true }));
    }
    ui.openPanel = openPanel;

    function setStoreUi(patch) {
        const cur = store.get().ui;
        for (const k in patch) {
            if (cur[k] !== patch[k]) { store.set({ ui: { ...cur, ...patch } }); return; }
        }
    }

    // ------------------------------------------------------------------ sheet behaviour
    let currentSnap = 'peek';
    let releaseTrap = null;
    let heights = { peek: 100, half: 300, full: 550 };
    let headH = 100;

    /** Heights above the tab bar: peek is the head (handle and time bar), half leaves ≥ 190 px of content. */
    function measureSheet() {
        // The tab bar's top (fixed, so offsetTop is in the viewport; a tablet's floats 12 px up).
        const above = nav.offsetTop || window.innerHeight - 56;
        headH = Math.round(handle.offsetHeight + (sheetHead.offsetHeight || 82));
        const full = Math.max(240, above - 56);
        const peek = Math.min(full, headH);
        const half = clamp(Math.round(above * 0.5), Math.min(full, peek + 192), full);
        heights = { peek, half, full };
        root.style.setProperty('--sheet-full', `${full}px`);
        root.style.setProperty('--sheet-head-h', `${headH}px`);
    }

    function setSnap(name, { animate = true, fromStore = false } = {}) {
        if (!SNAPS.includes(name)) name = 'peek';
        const changed = name !== currentSnap;
        currentSnap = name;
        sheet.classList.toggle('no-anim', !animate || ui.reducedMotion());
        sheet.style.removeProperty('transform');
        root.style.setProperty('--sheet-h', `${heights[name]}px`);
        root.dataset.sheet = name;
        // Content below the fold must not take keyboard focus.
        const folded = name === 'peek' && ui.layout === 'mobile';
        sheetBody.inert = folded;
        handle.setAttribute('aria-expanded', String(name !== 'peek'));
        handle.setAttribute('aria-label', name === 'full' ? 'Collapse panel' : 'Expand panel');
        if (!fromStore) setStoreUi({ sheet: name });
        // Focus trap only while the sheet covers the screen: the sheet and the tab bar.
        if (name === 'full' && ui.layout === 'mobile') {
            if (!releaseTrap) {
                const a = /** @type {HTMLElement} */ (document.activeElement);
                releaseTrap = trapFocus([sheet, nav], { initial: sheet.contains(a) || nav.contains(a) ? a : handle, restore: false });
            }
        } else if (releaseTrap) { releaseTrap(); releaseTrap = null; }
        if (changed) ui.emit('sheet', name);
    }

    // Drag: pointer on the handle or any non-interactive part of the sheet head.
    let drag = null;
    let suppressClick = false;
    offs.push(on(sheet, 'pointerdown', (e) => {
        if (ui.layout !== 'mobile' || e.button > 0) return;
        const t = /** @type {HTMLElement} */ (e.target);
        const onHandle = !!t.closest('.sheet__handle');
        const inHead = !!t.closest('.sheet__head');
        if (!onHandle && !inHead) return;
        if (!onHandle && t.closest('button, a, input, select, textarea, [role="slider"], .tb-scrub')) return;
        const vis = heights[currentSnap];
        drag = { id: e.pointerId, y0: e.clientY, vis0: vis, vis, lastY: e.clientY, lastT: e.timeStamp, v: 0, moved: false };
    }));
    // On the window: before the capture, a quick drag may leave the sheet's top edge.
    offs.push(on(window, 'pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dy = e.clientY - drag.y0;
        if (!drag.moved && Math.abs(dy) < 4) return;
        // Captured only once it is a drag: a press that does not move still clicks the handle.
        if (!drag.moved) { drag.moved = true; sheet.classList.add('is-dragging'); sheet.setPointerCapture?.(e.pointerId); }
        let vis = drag.vis0 - dy;
        // Rubber-band beyond the end points.
        if (vis > heights.full) vis = heights.full + (vis - heights.full) * 0.25;
        if (vis < heights.peek) vis = heights.peek - (heights.peek - vis) * 0.25;
        drag.vis = vis;
        const dt = Math.max(1, e.timeStamp - drag.lastT);
        const inst = (e.clientY - drag.lastY) / dt;
        drag.v = drag.v * 0.6 + inst * 0.4;
        drag.lastY = e.clientY; drag.lastT = e.timeStamp;
        sheet.style.transform = `translate3d(0, ${Math.round(heights.full - vis)}px, 0)`;
    }));
    const endDrag = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const d = drag;
        drag = null;
        sheet.classList.remove('is-dragging');
        if (!d.moved) return; // a tap: the handle's click handler decides
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
        // Stale velocity (finger rested before lifting) does not count as a fling.
        const v = e.timeStamp - d.lastT > 120 ? 0 : d.v;
        let target;
        if (Math.abs(v) > FLING_PX_PER_MS) {
            const order = SNAPS.map((n) => ({ n, hgt: heights[n] }));
            if (v < 0) target = (order.find((o) => o.hgt > d.vis + 8) || order[2]).n;
            else target = ([...order].reverse().find((o) => o.hgt < d.vis - 8) || order[0]).n;
        } else {
            target = SNAPS.reduce((best, n) => (Math.abs(heights[n] - d.vis) < Math.abs(heights[best] - d.vis) ? n : best), 'peek');
        }
        setSnap(target, { animate: true });
    };
    offs.push(on(window, 'pointerup', endDrag));
    offs.push(on(window, 'pointercancel', endDrag));
    offs.push(on(handle, 'click', () => {
        if (suppressClick) return;
        const next = currentSnap === 'peek' ? 'half' : currentSnap === 'half' ? 'full' : 'peek';
        setSnap(next, { animate: true });
    }));
    offs.push(on(handle, 'keydown', (e) => {
        const i = SNAPS.indexOf(currentSnap);
        if (e.key === 'ArrowUp' && i < 2) { e.preventDefault(); setSnap(SNAPS[i + 1]); }
        else if (e.key === 'ArrowDown' && i > 0) { e.preventDefault(); setSnap(SNAPS[i - 1]); }
    }));
    // Esc from the sheet or the tab bar (the trap at full covers both).
    const lowerOnEsc = (e) => {
        if (e.key === 'Escape' && currentSnap === 'full' && !store.get().ui.palette && !store.get().ui.help) {
            e.stopPropagation();
            setSnap('half');
            handle.focus();
        }
    };
    offs.push(on(sheet, 'keydown', lowerOnEsc), on(nav, 'keydown', lowerOnEsc));

    // ------------------------------------------------------------------ layouts
    const mq = window.matchMedia?.(MOBILE_QUERY);
    function computeLayout() {
        if (document.body.classList.contains('no-webgl') || store.get().status?.webgl === false) return 'text';
        return mq?.matches ? 'mobile' : 'desktop';
    }
    let applied = '';
    function applyLayout() {
        const mode = computeLayout();
        if (mode === applied) return;
        applied = mode;
        ui.layout = mode;
        root.dataset.layout = mode;
        if (releaseTrap) { releaseTrap(); releaseTrap = null; }
        if (mode === 'mobile') {
            setRail(false);
            sheetHead.append(timebarEl);
            sheetBody.append(panelEl);
            nav.append(tablist);
            root.append(skip, topbarEl, modes.el, hudEl, viewbarEl, sheet, nav, overlay);
        } else {
            sheetBody.inert = false;
            panelHead.prepend(tablist);
            // Text mode: the Eclipse Companion inline, then the toolbar, above Up now.
            if (mode === 'text') root.append(skip, topbarEl, modes.el, timebarEl, hudEl, viewbarEl, panelEl, overlay);
            else root.append(skip, topbarEl, modes.el, hudEl, viewbarEl, timebarEl, panelEl, overlay);
            sheet.remove();
            nav.remove();
        }
        ui.emit('layout', mode);
        requestAnimationFrame(() => {
            if (mode === 'mobile') { measureSheet(); setSnap(store.get().ui?.sheet || currentSnap, { animate: false, fromStore: true }); }
            placeInk();
            measureTimebar();
        });
    }
    if (mq) offs.push(on(mq, 'change', applyLayout));
    const bodyObserver = new MutationObserver(() => {
        applyLayout();
        root.classList.toggle('is-cinema', document.body.classList.contains('is-cinema') || !!store.get().ui?.cinema);
    });
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    // Time-bar height drives toast / view-switch offsets (CSS var).
    function measureTimebar() {
        const hgt = timebarEl.offsetHeight;
        if (hgt) root.style.setProperty('--tb-h', `${hgt}px`);
    }
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
        measureTimebar();
        placeInk();
        if (ui.layout === 'mobile') {
            const before = heights.peek;
            measureSheet();
            if (heights.peek !== before || !drag) {
                sheet.classList.add('no-anim');
                root.style.setProperty('--sheet-h', `${heights[currentSnap]}px`);
                requestAnimationFrame(() => sheet.classList.remove('no-anim'));
            }
        }
    }) : null;
    ro?.observe(timebarEl);
    ro?.observe(sheetHead);
    ro?.observe(tablist);
    offs.push(on(window, 'resize', () => {
        if (ui.layout === 'mobile') { measureSheet(); root.style.setProperty('--sheet-h', `${heights[currentSnap]}px`); }
        placeInk();
    }));

    // ------------------------------------------------------------------ store bindings
    offs.push(store.subscribe((s) => s.ui?.panel, (p) => selectTab(p || 'sky'), { immediate: true }));
    offs.push(store.subscribe((s) => s.ui?.sheet, (snap) => {
        if (snap && snap !== currentSnap && ui.layout === 'mobile') setSnap(snap, { fromStore: true });
        else if (snap) currentSnap = snap;
    }, { immediate: true }));
    offs.push(store.subscribe((s) => s.ui?.cinema, (c) => {
        root.classList.toggle('is-cinema', !!c || document.body.classList.contains('is-cinema'));
    }, { immediate: true }));
    offs.push(store.subscribe((s) => s.status?.webgl, () => applyLayout()));
    // A new selection brings its card forward when the user is looking at sky information.
    function showSelection(id) {
        if (!id) return;
        if (activeTab === 'sky' || activeTab === 'details') {
            setStoreUi({ panel: 'details' });
            selectTab('details');
            if (ui.layout === 'desktop' && railed) setRail(false);
        }
    }
    offs.push(store.subscribe((s) => s.selection, showSelection));

    // ------------------------------------------------------------------ pick on the globe (a mode chip)
    let hintTimer = 0;
    let hintOff = null;
    ui.pickHint = (show) => {
        clearTimeout(hintTimer);
        hintOff?.(); hintOff = null;
        if (!show) { ui.modes.clear('pick'); return; }
        ui.modes.set('pick', { icon: 'pin', title: 'Pick a place', detail: 'Click or tap anywhere on Earth',
            exit: { label: 'Cancel', done: 'Picking cancelled', run: () => ui.pickHint(false) } });
        ctx.bus.emit('announce', 'Pick a place: click or tap anywhere on Earth');
        hintTimer = setTimeout(() => ui.pickHint(false), 15000);
        hintOff = store.subscribe((s) => s.observer, () => ui.pickHint(false));
    };

    // ------------------------------------------------------------------ cinema exit (touch-friendly)
    let wakeTimer = 0;
    offs.push(on(cinemaExit, 'click', () => ui.act('toggleCinema')));
    const wake = () => {
        if (!root.classList.contains('is-cinema')) return;
        root.classList.add('is-awake');
        clearTimeout(wakeTimer);
        wakeTimer = setTimeout(() => root.classList.remove('is-awake'), 2400);
    };
    offs.push(on(window, 'pointermove', wake, { passive: true }));
    offs.push(on(window, 'pointerdown', wake, { passive: true }));

    applyLayout();
    selectTab(store.get().ui?.panel || 'sky');
    // A selection that was there before the shell (a shared link's `sel=`) opens its card too,
    // unless a tab other than Up now is already showing.
    if (activeTab === 'sky') showSelection(store.get().selection);

    return {
        overlay,
        update(snap) {
            for (const c of [children[0], timebar, hud]) {
                try { c?.update?.(snap); } catch (err) { console.error('[ui] update failed', err); }
            }
            const mod = tabs[activeTab]?.mod;
            if (mod?.update) mod.update(snap);
        },
        destroy() {
            offs.forEach((off) => off());
            bodyObserver.disconnect();
            ro?.disconnect();
            releaseTrap?.();
            hintOff?.();
            clearTimeout(hintTimer);
            clearTimeout(wakeTimer);
            for (const c of children) { try { c?.destroy?.(); } catch { /* keep tearing down */ } }
            root.textContent = '';
            delete root.dataset.layout;
            delete root.dataset.sheet;
        },
    };
}
