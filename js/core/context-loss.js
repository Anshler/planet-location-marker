// What a lost WebGL context leads to (context-loss-backoff-and-diagnostics).
//
// A loss is usually GPU memory pressure (a phone backgrounding the tab, an Android OOM), and the
// same footprint is likely to be lost again. Losses are counted in a sliding window: the first
// restores at the same tier, a second within LOSS_WINDOW_MS holds the session one tier lower, and a
// third gives up on the 3D view (text mode, with Retry). main.js keeps the record in sessionStorage
// (js/app/session.js), so a tab that reloads instead of restoring (iOS) boots with the same step.

import { ALL_TIERS } from './quality.js';

/** Losses closer together than this (ms) count together. */
export const LOSS_WINDOW_MS = 60e3;

/** @typedef {{n:number, t:number[], cap:string|null, text:boolean}} LossRecord */

const rank = (t) => ALL_TIERS.indexOf(t);

/**
 * A stored loss record made safe: `n` losses this session, `t` the recent ones (epoch ms, at most
 * three), `cap` the tier the session is held at or below (or null) and `text`: the 3D view gave up.
 * @param {unknown} raw
 * @returns {LossRecord}
 */
export function lossRecord(raw) {
    const r = raw && typeof raw === 'object' ? /** @type {any} */ (raw) : {};
    const t = Array.isArray(r.t) ? r.t.filter(Number.isFinite).slice(-3) : [];
    return { n: Number.isInteger(r.n) && r.n > 0 ? r.n : t.length, t, cap: rank(r.cap) >= 0 ? r.cap : null, text: r.text === true };
}

/**
 * The tier one below (max → high → medium → low), or null at low.
 * @param {string} tier
 * @returns {string|null}
 */
export function tierBelow(tier) {
    const i = rank(tier);
    return i > 0 ? ALL_TIERS[i - 1] : null;
}

/**
 * The lower of a tier and a cap (no cap: the tier).
 * @param {string} tier
 * @param {string|null} cap
 * @returns {string}
 */
export function capTier(tier, cap) {
    return cap && rank(cap) >= 0 && rank(cap) < rank(tier) ? cap : tier;
}

/**
 * Counts a loss at `nowMs` while `tier` runs. 'restore': restore as before; 'step-down': the
 * session is held at `record.cap`, one tier below `tier` (a second loss within the window; at low
 * there is nothing lower, so it restores); 'text': a third, text mode.
 * @param {unknown} raw the stored record (or null)
 * @param {number} nowMs epoch ms
 * @param {string} tier the active tier
 * @returns {{record:LossRecord, action:'restore'|'step-down'|'text'}}
 */
export function recordLoss(raw, nowMs, tier) {
    const r = lossRecord(raw);
    const t = [...r.t.filter((x) => x <= nowMs && nowMs - x < LOSS_WINDOW_MS), nowMs];
    const record = { n: r.n + 1, t, cap: r.cap, text: r.text };
    if (t.length >= 3) {
        record.text = true;
        return { record, action: 'text' };
    }
    const below = t.length === 2 ? tierBelow(tier) : null;
    if (!below) return { record, action: 'restore' };
    record.cap = capTier(below, r.cap);
    return { record, action: 'step-down' };
}

/**
 * The record after Retry (text mode → the 3D view again): the window starts afresh and the
 * session is held at low.
 * @param {unknown} raw
 * @returns {LossRecord}
 */
export function retryRecord(raw) {
    const r = lossRecord(raw);
    return { n: r.n, t: [], cap: 'low', text: false };
}
