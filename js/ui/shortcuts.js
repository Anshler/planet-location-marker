/**
 * Global keyboard shortcuts (SPEC F.3), matched on `e.code` so they follow
 * physical keys on any layout. Ignored while focus is in an input, textarea or
 * select (except Esc), and while Ctrl/Cmd is held (except Ctrl/Cmd+K), so
 * browser shortcuts keep working. Space on a focused button keeps its native
 * meaning. Arrow keys and +/− belong to the camera rig and are not handled here;
 * Backquote calls `actions.toggleDebug()` when the app provides it.
 *
 * Every change also flashes a short visual confirmation ("Beams off").
 *
 * @module ui/shortcuts
 */

import { BODIES } from '../astro/bodies.js';
import { LAYER_GROUPS } from './layers.js';

const LAYER_LABEL = Object.fromEntries(LAYER_GROUPS.flatMap((g) => g.items.map(([k, l]) => [k, l])));
const bound = new WeakMap();
const STEP_LABEL = { hour: '1 hour', day: '1 day', siderealDay: '1 sidereal day' };

/** True when the event target is a text-entry control. */
function isTyping(t) {
    if (!t || !(t instanceof Element)) return false;
    if (/** @type {HTMLElement} */ (t).isContentEditable) return true;
    const tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    const type = (t.getAttribute('type') || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type);
}

/**
 * Installs the keydown handler.
 * @param {any} ctx UiCtx (with `ctx.ui`)
 * @returns {() => void} off
 */
export function bindShortcuts(ctx) {
    const { store, clock, ui } = ctx;
    // Idempotent per store: a second binding (e.g. by the app) is a no-op.
    if (bound.has(store)) return () => {};
    const flash = (text) => ui?.flash?.(text);
    const act = (name, ...args) => (ui?.act ? ui.act(name, ...args) : ctx.actions?.[name]?.(...args));

    function toggleLayer(key) {
        const on = !store.get().layers?.[key];
        const text = `${LAYER_LABEL[key] || key} ${on ? 'on' : 'off'}`;
        // actions.toggleLayer announces the change itself; announce only on the fallback path.
        if (typeof ctx.actions?.toggleLayer === 'function') act('toggleLayer', key, on);
        else { store.set({ layers: { ...store.get().layers, [key]: on } }); ctx.bus?.emit?.('announce', text); }
        flash(text);
    }
    const rateText = () => (ui?.fmt ? ui.fmt('fmtRate', clock.rate) : String(clock.rate));

    function onEscape(e) {
        const st = store.get();
        if (st.ui?.palette) { ui?.closePalette?.(); e.preventDefault(); return; }
        if (st.ui?.help) { ui?.toggleHelp?.(false); e.preventDefault(); return; }
        if (isTyping(e.target)) { /** @type {HTMLElement} */ (e.target).blur(); return; }
        if (st.ui?.cinema) { act('toggleCinema'); e.preventDefault(); return; }
        if (st.selection) { act('select', null); e.preventDefault(); }
    }

    /** @param {KeyboardEvent} e */
    function onKey(e) {
        if (e.defaultPrevented || e.isComposing) return;
        if (e.key === 'Escape') { onEscape(e); return; }
        if (isTyping(e.target)) return;
        const st = store.get();
        const mod = e.ctrlKey || e.metaKey;
        if (mod && !e.altKey && e.code === 'KeyK') { e.preventDefault(); ui?.openPalette?.(); return; }
        if (mod) return;
        // Help works even over other dialogs.
        if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) { e.preventDefault(); ui?.toggleHelp?.(); return; }
        if (st.ui?.palette || st.ui?.help) return;
        const t = /** @type {Element} */ (e.target);
        const onControl = !!t?.closest?.('button, a[href], [role="switch"], [role="tab"], [role="slider"], [role="option"], [role="radio"], summary');
        if ((e.code === 'Space' || e.code === 'Enter') && onControl) return;
        // Arrow keys inside composite widgets are theirs.
        if (e.code.startsWith('Arrow') || (e.code === 'Home' && onControl)) return;

        let handled = true;
        const code = e.code;
        if (code === 'Space') {
            clock.toggle();
            flash(clock.playing ? 'Playing' : 'Paused');
        } else if (code === 'BracketLeft') {
            clock.slower(); flash(`Speed ${rateText()}`);
        } else if (code === 'BracketRight') {
            clock.faster(); flash(`Speed ${rateText()}`);
        } else if (code === 'KeyR' && !e.shiftKey) {
            clock.reverse(); flash(clock.rate < 0 ? 'Time runs backward' : 'Time runs forward');
        } else if (code === 'Comma' || code === 'Period') {
            const kind = e.altKey ? 'siderealDay' : e.shiftKey ? 'day' : 'hour';
            const n = code === 'Comma' ? -1 : 1;
            clock.step(kind, n);
            flash(`${n < 0 ? '−' : '+'}${STEP_LABEL[kind]}`);
        } else if (code === 'KeyN') {
            clock.goLive(); flash('Live');
        } else if (/^(Digit|Numpad)[1-9]$/.test(code) && !e.shiftKey && !e.altKey) {
            const b = BODIES[Number(code.slice(-1)) - 1];
            if (b) {
                if (st.selection === b.id) act('flyToBody', b.id);
                else act('select', b.id);
                flash(b.name);
            }
        } else if ((code === 'Digit0' || code === 'Numpad0') && !e.shiftKey) {
            act('select', null);
        } else if (code === 'KeyV') {
            act('cycleView');
            flash(store.get().view?.mode === 'sky' ? 'Sky view' : 'Globe view');
        } else if (code === 'KeyL') {
            const on = !st.view?.earthLock;
            act('setEarthLock', on);
            flash(on ? 'View locked to Earth' : 'View unlocked');
        } else if (code === 'KeyB') toggleLayer('beams');
        else if (code === 'KeyC') toggleLayer(e.shiftKey ? 'constellationNames' : 'constellations');
        else if (code === 'KeyM') toggleLayer('milkyWay');
        else if (code === 'KeyE') toggleLayer('ecliptic');
        else if (code === 'KeyG') toggleLayer('eqGrid');
        else if (code === 'KeyO') toggleLayer('footprint');
        else if (code === 'KeyT') toggleLayer('trails');
        else if (code === 'Slash') ui?.openPalette?.();
        else if (code === 'KeyS') ui?.share ? ui.share() : act('share');
        else if (code === 'KeyF') act('toggleFullscreen');
        else if (code === 'KeyH') act('toggleCinema');
        else if (code === 'Home') act('resetCamera');
        else if (code === 'Backquote' && typeof ctx.actions?.toggleDebug === 'function') act('toggleDebug');
        else handled = false;
        if (handled) e.preventDefault();
    }

    window.addEventListener('keydown', onKey);
    bound.set(store, true);
    return () => {
        window.removeEventListener('keydown', onKey);
        bound.delete(store);
    };
}
