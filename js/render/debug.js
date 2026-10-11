/**
 * `?debug=1` overlay (SPEC §B SHOULD, §C.6): fps, frame ms, draw calls,
 * triangles, renderer.info.memory, programs, tier, DPR and buffer size, plus a
 * sparkline of the last 120 rendered frame times against the 16.7 ms budget.
 *
 *   createDebugOverlay(rc, rootEl) → { update(dtMs), setVisible(on), toggle(), visible, dispose() }
 *
 * `update(dtMs)` is cheap: it records the frame time in a ring buffer; text
 * and sparkline are refreshed at most 4× per second. Styles are inline (this
 * panel is a developer tool, not part of the designed UI) and it never takes
 * pointer events. Because the app renders on demand, the numbers describe
 * rendered frames only.
 *
 * @module render/debug
 */

const HISTORY = 120;
const REFRESH_MS = 250;
const BUDGET_MS = 1000 / 60;

/**
 * @param {object} rc RenderContext
 * @param {HTMLElement} [rootEl] parent element (default document.body)
 * @returns {{update(dtMs:number):void, setVisible(on:boolean):void, toggle():boolean, readonly visible:boolean, dispose():void}}
 */
export function createDebugOverlay(rc, rootEl) {
    const doc = rootEl?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const parent = rootEl || doc?.body || null;
    const times = new Float32Array(HISTORY);
    let head = 0;
    let filled = 0;
    let emaDt = 0;
    let lastRefresh = -Infinity;
    let visible = true;

    if (!doc || !parent) {
        return { update() {}, setVisible() {}, toggle() { return false; }, get visible() { return false; }, dispose() {} };
    }

    const panel = doc.createElement('div');
    panel.setAttribute('aria-hidden', 'true');
    panel.className = 'debug-overlay';
    Object.assign(panel.style, {
        position: 'fixed', left: '8px', top: '64px', zIndex: '9999', pointerEvents: 'none',
        font: '11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', color: '#cfe3ff',
        background: 'rgba(4, 8, 16, 0.72)', border: '1px solid rgba(124, 196, 255, 0.25)', borderRadius: '8px',
        padding: '6px 8px 8px', whiteSpace: 'pre', minWidth: '172px', userSelect: 'none',
        fontVariantNumeric: 'tabular-nums',
    });
    const text = doc.createElement('div');
    const canvas = doc.createElement('canvas');
    const W = HISTORY, H = 28;
    const ratio = Math.min(2, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    canvas.width = Math.round(W * ratio);
    canvas.height = Math.round(H * ratio);
    Object.assign(canvas.style, { display: 'block', width: `${W}px`, height: `${H}px`, marginTop: '4px' });
    panel.append(text, canvas);
    parent.appendChild(panel);
    const g = canvas.getContext('2d');

    function drawSpark() {
        if (!g) return;
        g.setTransform(ratio, 0, 0, ratio, 0, 0);
        g.clearRect(0, 0, W, H);
        const maxMs = BUDGET_MS * 3;
        // Budget guide.
        const yBudget = H - (BUDGET_MS / maxMs) * H;
        g.fillStyle = 'rgba(124, 196, 255, 0.25)';
        g.fillRect(0, Math.round(yBudget), W, 1);
        for (let i = 0; i < filled; i++) {
            const idx = (head - filled + i + HISTORY) % HISTORY;
            const ms = times[idx];
            const h = Math.min(H, (ms / maxMs) * H);
            g.fillStyle = ms > BUDGET_MS * 1.3 ? '#ff7a6b' : ms > BUDGET_MS ? '#ffcc66' : '#5fd38d';
            g.fillRect(W - filled + i, H - h, 1, h);
        }
    }

    function refresh() {
        let s = null;
        try { s = rc?.stats?.(); } catch { s = null; }
        const tier = rc?.tier?.name ?? rc?.tier ?? '?';
        const dpr = Number(rc?.dpr ?? 1);
        const w = rc?.size?.w ?? 0, h = rc?.size?.h ?? 0;
        const fps = emaDt > 0 ? 1000 / emaDt : 0;
        const lines = [
            `${fps.toFixed(1).padStart(5)} fps  ${emaDt.toFixed(1).padStart(5)} ms`,
            `tier ${tier}  dpr ${dpr.toFixed(2)}${rc?.postfx ? '  fx' : ''}${rc?.lost ? '  LOST' : ''}`,
            `${w}×${h} → ${Math.round(w * dpr)}×${Math.round(h * dpr)}`,
        ];
        if (s) {
            lines.push(`calls ${s.drawCalls}  tris ${formatCount(s.triangles)}`);
            lines.push(`geo ${s.geometries}  tex ${s.textures}  prog ${s.programs}`);
        }
        text.textContent = lines.join('\n');
        drawSpark();
    }

    return {
        /**
         * Records one rendered frame.
         * @param {number} dtMs
         */
        update(dtMs) {
            if (!Number.isFinite(dtMs) || dtMs <= 0) return;
            times[head] = dtMs;
            head = (head + 1) % HISTORY;
            if (filled < HISTORY) filled++;
            emaDt = emaDt > 0 ? emaDt + (dtMs - emaDt) * 0.05 : dtMs;
            if (!visible) return;
            const t = typeof performance !== 'undefined' ? performance.now() : Date.now();
            if (t - lastRefresh >= REFRESH_MS) {
                lastRefresh = t;
                refresh();
            }
        },
        setVisible(on) {
            visible = !!on;
            panel.style.display = visible ? '' : 'none';
            if (visible) refresh();
        },
        toggle() {
            this.setVisible(!visible);
            return visible;
        },
        get visible() { return visible; },
        dispose() {
            panel.remove();
        },
    };
}

function formatCount(n) {
    if (!Number.isFinite(n)) return '0';
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(n);
}
