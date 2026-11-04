/**
 * 'Report a problem' (Display › About this app; context-loss-backoff-and-diagnostics): Copy diagnostics puts the
 * report of actions.copyDiagnostics (core/diagnostics.js: version, graphics, recent errors, never
 * the place) on the clipboard, or shows it to select by hand where copying is blocked, and a link
 * opens a new GitHub issue on REPO_URL with a short template to paste it into. Nothing is sent by
 * the app itself.
 *
 * @module ui/report
 */

import { APP_NAME, VERSION, REPO_URL } from '../version.js';
import { h, on, setText } from './dom.js';
import { icon } from './icons.js';

/**
 * The prefilled 'new issue' link: a template with the version, no diagnostics (the user pastes them).
 * @returns {string}
 */
export function issueUrl() {
    const body = `**What happened?**\n\n\n**What did you expect?**\n\n\n**Diagnostics** (Display › About this app › Copy diagnostics, then paste here; `
        + `it holds no location):\n\n\`\`\`json\n\n\`\`\`\n\n${APP_NAME} ${VERSION}\n`;
    return `${REPO_URL}/issues/new?${new URLSearchParams({ body })}`;
}

/**
 * Mounts the 'Report a problem' group.
 * @param {any} ctx UiCtx (ctx.actions.copyDiagnostics)
 * @returns {{el: HTMLElement, destroy(): void}}
 */
export function mountReport(ctx) {
    const copy = h('button', { class: 'btn btn--soft', type: 'button' }, icon('copy', { size: 15 }), 'Copy diagnostics');
    const issue = h('a', { class: 'btn btn--soft', href: issueUrl(), target: '_blank', rel: 'noopener noreferrer' },
        'Report an issue', icon('external', { size: 13 }));
    const status = h('p', { class: 'setting__hint', role: 'status', 'aria-live': 'polite' });
    const text = h('textarea', { class: 'input report__text', readonly: true, rows: 8, hidden: true, 'aria-label': 'Diagnostics' });
    const off = on(copy, 'click', async () => {
        const r = await ctx.actions?.copyDiagnostics?.();
        if (!r) return;
        text.value = r.text;
        text.hidden = r.ok;
        setText(status, r.ok ? 'Copied. Paste it into the issue.' : 'Copying is blocked here: select the text below and copy it.');
        if (!r.ok) text.select();
    });
    const el = h('div', { class: 'group' },
        h('h3', { class: 'group-title' }, 'Report a problem'),
        h('p', { class: 'prose' }, 'Something looks wrong? Copy the diagnostics (version, graphics, settings and recent errors; '
            + 'never your location) and paste them into a new issue.'),
        h('div', { class: 'btn-row btn-row--wrap' }, copy, issue),
        status, text);
    return { el, destroy: off };
}
