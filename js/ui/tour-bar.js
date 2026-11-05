/**
 * The guided tour's lower third (store ui.tour, set by js/app/tours.js): eyebrow with the tour and
 * step, the caption, a step progress line, and Next / End tour (Resume / End tour once paused).
 * The caption cross-fades on change (opacity only); the runner mirrors it to the announcer, so the
 * bar itself is not a live region. `data-tour-ui` tells the runner that input here is not an
 * interruption. Ambient shows only while a caption is up.
 * @module ui/tour-bar
 */

import { h, on, setText } from './dom.js';
import { icon } from './icons.js';
import { t } from '../core/i18n.js';

/**
 * @param {HTMLElement} root overlay container
 * @param {any} ctx UiCtx
 * @returns {{destroy(): void}}
 */
export function mountTourBar(root, ctx) {
    const { store, ui } = ctx;
    const offs = [];
    const eye = h('span', { class: 'tour-bar__eye' });
    const text = h('p', { class: 'tour-bar__text' });
    const fill = h('span', { class: 'tour-bar__fill' });
    const nextBtn = h('button', { class: 'btn btn--soft btn--sm', type: 'button', 'data-tour-act': 'next' }, t('Next'), icon('chevron-right', { size: 16 }));
    const resumeBtn = h('button', { class: 'btn btn--primary btn--sm', type: 'button', 'data-tour-act': 'resume', hidden: true }, icon('play', { size: 16 }), t('Resume'));
    const endBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'data-tour-act': 'end', 'aria-label': t('End the tour (Esc)') }, icon('close', { size: 16 }), t('End tour'));
    const el = h('section', { class: 'tour-bar glass', 'data-tour-ui': '', 'aria-label': t('Guided tour'), hidden: true },
        h('div', { class: 'tour-bar__main' }, eye, text, h('span', { class: 'tour-bar__track', 'aria-hidden': 'true' }, fill)),
        h('div', { class: 'tour-bar__btns' }, resumeBtn, nextBtn, endBtn));
    root.appendChild(el);

    offs.push(on(el, 'click', (e) => {
        const b = /** @type {HTMLElement} */ (e.target).closest('[data-tour-act]');
        if (!b) return;
        const act = b.dataset.tourAct;
        if (act === 'next') ui.act('nextTourStep');
        else if (act === 'resume') ui.act('resumeTour');
        else ui.act('stopTour');
    }));

    let lastCaption = null;
    function render(tour) {
        const show = !!tour && !(tour.ambient && !tour.caption);
        el.hidden = !show;
        if (!tour) {
            lastCaption = null;
            return;
        }
        // The catalogue's title and the step's caption are English, shown in the locale (t()).
        const title = t(tour.title);
        setText(eye, tour.paused ? t('{title} · paused', { title }) : tour.steps > 0 && !tour.ambient
            ? t('{title} · {step} of {steps}', { title, step: Math.min(tour.step, tour.steps), steps: tour.steps }) : title);
        if (tour.caption !== lastCaption) {
            lastCaption = tour.caption;
            setText(text, t(tour.caption));
            // Restart the fade-in without forcing a layout read in between.
            text.classList.remove('is-in');
            requestAnimationFrame(() => text.classList.add('is-in'));
        }
        fill.style.transform = `scaleX(${tour.steps > 0 ? Math.min(1, tour.step / tour.steps) : 0})`;
        el.classList.toggle('is-paused', !!tour.paused);
        el.classList.toggle('is-ambient', !!tour.ambient);
        resumeBtn.hidden = !tour.paused;
        nextBtn.hidden = !!tour.ambient && !tour.paused;
    }
    offs.push(store.subscribe((s) => s.ui.tour, render, { immediate: true }));

    return {
        destroy() {
            offs.forEach((off) => off());
            el.remove();
        },
    };
}
