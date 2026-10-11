/**
 * Astro worker: runs the heavier almanac, event and path searches off the
 * main thread. Loaded as a module worker by client.js:
 *   new Worker(new URL('./worker.js', import.meta.url), {type: 'module'})
 * Importmaps do not apply inside workers, so everything here (and below) is
 * imported by relative path only.
 *
 * Protocol: the page posts {id, op, args}; the worker replies
 * {id, ok: true, result} or {id, ok: false, error: {name, message}}, and posts
 * {type: 'ready'} once after loading. Typed arrays in results are transferred.
 *
 * The same module is importable on the main thread (client.js falls back to
 * `runOp` when workers are unavailable); it only installs its message handler
 * when it actually runs inside a WorkerGlobalScope.
 *
 * @module astro/worker
 */
import { riseTransitSet, twilight, tonight, sunAltitudeSeries, aeObserverOf } from './almanac.js';
import { upcomingEvents } from './events.js';
import { apparentPath, stationaryPoints } from './paths.js';
import { BODY_IDS } from './bodies.js';

function riseSetAll({ bodyIds, observer, fromMs, toMs }) {
    aeObserverOf(observer); // validate once so a bad observer fails the whole request clearly
    const ids = Array.isArray(bodyIds) && bodyIds.length ? bodyIds : BODY_IDS;
    const out = {};
    for (const id of ids) out[id] = riseTransitSet(id, observer, fromMs, toMs);
    return out;
}

/**
 * Operation table. Each op takes one plain-object argument and returns a
 * structured-cloneable result.
 *  - riseSet   {bodyIds?, observer, fromMs, toMs}        → {[id]: RTS} (all bodies when bodyIds is omitted)
 *  - twilight  {observer, nearMs}                        → Twilight
 *  - tonight   {observer, nearMs, tz?, hour12?}          → {nightStartMs, nightEndMs, reports, twilight}
 *  - events    {observer, fromMs, days?}                 → AstroEvent[]
 *  - path      {bodyId, centerMs, halfSpanDays?, stepHours?} → ApparentPath & {stations: StationaryPoint[]}
 *  - sunSeries {observer, fromMs, toMs, n}               → Float32Array(n)
 *  - almanac   {observer, dayStartMs, dayEndMs?, nearMs?, sunFromMs?, sunToMs?, n?, tz?, hour12?}
 *              → {riseSet, twilight, tonight, sunSeries:{fromMs, toMs, values}} in one round trip
 *  - ping      {}                                        → 'pong'
 * @type {Readonly<Record<string, (args:object) => unknown>>}
 */
export const OPS = Object.freeze({
    riseSet: riseSetAll,
    twilight: ({ observer, nearMs }) => twilight(observer, nearMs),
    tonight: ({ observer, nearMs, tz, hour12 }) => tonight(observer, nearMs, { tz, hour12 }),
    events: ({ observer, fromMs, days }) => upcomingEvents(observer, fromMs, days ?? 365),
    path: ({ bodyId, centerMs, halfSpanDays, stepHours }) => {
        const path = apparentPath(bodyId, centerMs, halfSpanDays ?? 180, stepHours ?? 24);
        return { ...path, stations: stationaryPoints(path) };
    },
    sunSeries: ({ observer, fromMs, toMs, n }) => sunAltitudeSeries(observer, fromMs, toMs, n),
    almanac: (args) => {
        const { observer, dayStartMs } = args;
        const dayEndMs = args.dayEndMs ?? dayStartMs + 86400000;
        const nearMs = args.nearMs ?? dayStartMs;
        const sunFromMs = args.sunFromMs ?? dayStartMs;
        const sunToMs = args.sunToMs ?? dayEndMs;
        return {
            riseSet: riseSetAll({ observer, fromMs: dayStartMs, toMs: dayEndMs }),
            twilight: twilight(observer, nearMs),
            tonight: tonight(observer, nearMs, { tz: args.tz, hour12: args.hour12 }),
            sunSeries: { fromMs: sunFromMs, toMs: sunToMs, values: sunAltitudeSeries(observer, sunFromMs, sunToMs, args.n ?? 96) },
        };
    },
    ping: () => 'pong',
});

/**
 * Runs one operation synchronously.
 * @param {string} op
 * @param {object} [args]
 * @returns {unknown}
 * @throws {RangeError} For an unknown op; any error thrown by the op itself.
 */
export function runOp(op, args) {
    if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(OPS, op)) {
        throw new RangeError(`Unknown astro op: ${String(op)}`);
    }
    return OPS[op](args ?? {});
}

/**
 * ArrayBuffers of typed arrays found in a result (top level, one level of
 * object nesting, and the `values` of nested objects), for zero-copy postMessage.
 * @param {unknown} result
 * @returns {ArrayBuffer[]}
 */
export function transferablesOf(result) {
    const buffers = new Set();
    const add = (v) => {
        if (ArrayBuffer.isView(v) && v.buffer instanceof ArrayBuffer) buffers.add(v.buffer);
    };
    if (ArrayBuffer.isView(result)) {
        add(result);
    } else if (result && typeof result === 'object' && !Array.isArray(result)) {
        for (const v of Object.values(result)) {
            add(v);
            if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) add(v.values);
        }
    }
    return [...buffers];
}

/**
 * Error → plain {name, message}. astronomy-engine throws bare strings.
 * @param {unknown} e
 * @returns {{name:string, message:string}}
 */
export function serializeError(e) {
    if (e instanceof Error) return { name: e.name, message: e.message };
    return { name: 'Error', message: String(e) };
}

/**
 * Handles one request message and posts exactly one reply via `post`.
 * Exposed for tests; the worker wires it to `postMessage`.
 * @param {{id:unknown, op:string, args?:object}} data
 * @param {(msg:object, transfer?:ArrayBuffer[]) => void} post
 */
export function handleMessage(data, post) {
    const id = data && typeof data === 'object' ? data.id : undefined;
    let result;
    try {
        result = runOp(data?.op, data?.args);
    } catch (e) {
        post({ id, ok: false, error: serializeError(e) });
        return;
    }
    post({ id, ok: true, result }, transferablesOf(result));
}

const scope = globalThis;
if (typeof scope.WorkerGlobalScope === 'function' && scope instanceof scope.WorkerGlobalScope && typeof scope.postMessage === 'function') {
    scope.addEventListener('message', (ev) => handleMessage(ev.data, (msg, transfer) => scope.postMessage(msg, transfer || [])));
    scope.postMessage({ type: 'ready' });
}
