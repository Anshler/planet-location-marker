// HTTP helpers for the dev tooling: a tiny static file server (used by serve.mjs and
// smoke.mjs) and a download helper with timeout + retries (used by the fetch/build scripts).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/** Content types for everything the site ships (plus a few dev conveniences). */
export const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.wasm': 'application/wasm',
    '.bin': 'application/octet-stream',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
};

/** @param {string} file @returns {string} content type for a file name */
export const mimeFor = (file) => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/** Path segments that are never served: VCS internals, agent state, env files. */
const FORBIDDEN_SEGMENT = /^\.(git|svn|hg|claude|env)/i;

function normalisePrefix(p) {
    if (!p || p === '/') return '/';
    let s = p.startsWith('/') ? p : `/${p}`;
    if (!s.endsWith('/')) s += '/';
    return s;
}

const statOrNull = (f) => {
    try {
        return fs.statSync(f);
    } catch {
        return null;
    }
};

/**
 * Maps a request URL to a response decision without touching the socket.
 * @param {string} root site root (absolute or relative)
 * @param {string} prefix normalised sub-path ('/' or '/x/')
 * @param {string} reqUrl raw request URL (path + query)
 * @returns {{status:200, file:string, size:number}|{status:301, location:string}|{status:400|404}}
 */
export function resolveRequest(root, prefix, reqUrl) {
    const ROOT = path.resolve(root);   // no trailing separator, so the containment check holds
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(reqUrl, 'http://localhost').pathname);
    } catch {
        return { status: 400 };
    }
    if (prefix !== '/') {
        if (pathname === prefix.slice(0, -1)) return { status: 301, location: prefix };
        if (!pathname.startsWith(prefix)) return { status: 404 };
        pathname = '/' + pathname.slice(prefix.length);
    }
    const rel = path.normalize(pathname).replace(/^[/\\]+/, '');
    const file = path.join(ROOT, rel);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return { status: 404 };
    if (rel.split(/[/\\]/).some((seg) => FORBIDDEN_SEGMENT.test(seg))) return { status: 404 };
    const stat = statOrNull(file);
    if (!stat) return { status: 404 };
    if (!stat.isDirectory()) return { status: 200, file, size: stat.size };
    if (!pathname.endsWith('/')) {
        // Redirect /dir → /dir/ so the page's relative URLs resolve inside the directory.
        const [p, q] = reqUrl.split(/\?(.*)/s);
        return { status: 301, location: q === undefined ? `${p}/` : `${p}/?${q}` };
    }
    const index = path.join(file, 'index.html');
    const istat = statOrNull(index);
    return istat?.isFile() ? { status: 200, file: index, size: istat.size } : { status: 404 };
}

/**
 * Creates a static file server rooted at `root`.
 *
 * - `/dir` redirects to `/dir/`, and `/dir/` serves `dir/index.html`, so relative URLs work.
 * - Paths are decoded, normalised and confined to `root` (no traversal); `.git*`,
 *   `.claude*` and `.env*` are never served. Other dot-dirs (e.g. `.scratch/`) are.
 * - `cache: 'no-store'` (default) disables browser caching, which is what a dev server
 *   and the smoke test want; `'default'` sends no Cache-Control.
 * - `prefix` (e.g. '/planet-location-marker/') serves the site under a sub-path, like
 *   GitHub Pages does; requests outside it get 404 — handy to catch absolute URLs.
 *
 * @param {string} root directory to serve
 * @param {{cache?:'no-store'|'default', prefix?:string, log?:(line:string)=>void}} [opts]
 * @returns {{server:http.Server, listen:(port?:number, host?:string)=>Promise<string>, close:()=>Promise<void>, readonly url:string|null}}
 */
export function createStaticServer(root, opts = {}) {
    const ROOT = path.resolve(root);
    const prefix = normalisePrefix(opts.prefix);
    const baseHeaders = { 'X-Content-Type-Options': 'nosniff' };
    if ((opts.cache ?? 'no-store') === 'no-store') baseHeaders['Cache-Control'] = 'no-store';
    const log = opts.log ?? null;
    let url = null;

    const server = http.createServer((req, res) => {
        const t0 = Date.now();
        const finish = (status) => log?.(`${status} ${req.method} ${req.url} ${Date.now() - t0}ms`);
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { ...baseHeaders, Allow: 'GET, HEAD', 'Content-Type': 'text/plain' }).end('method not allowed');
            finish(405);
            return;
        }
        const r = resolveRequest(ROOT, prefix, req.url);
        if (r.status === 301) {
            res.writeHead(301, { ...baseHeaders, Location: r.location }).end();
        } else if (r.status !== 200) {
            res.writeHead(r.status, { ...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8' })
                .end(r.status === 404 ? 'not found' : 'bad request');
        } else {
            res.writeHead(200, { ...baseHeaders, 'Content-Type': mimeFor(r.file), 'Content-Length': r.size });
            if (req.method === 'HEAD') {
                res.end();
            } else {
                fs.createReadStream(r.file).on('error', () => res.destroy()).pipe(res);
            }
        }
        res.on('finish', () => finish(r.status));
    });

    return {
        server,
        get url() { return url; },
        listen(port = 0, host = '127.0.0.1') {
            return new Promise((resolve, reject) => {
                const onError = (err) => {
                    server.off('listening', onListening);
                    reject(err);
                };
                const onListening = () => {
                    server.off('error', onError);
                    const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
                    const hostPart = shown.includes(':') ? `[${shown}]` : shown;
                    url = `http://${hostPart}:${server.address().port}${prefix}`;
                    resolve(url);
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(port, host);
            });
        },
        close() {
            return new Promise((resolve) => {
                server.closeAllConnections?.();
                server.close(() => resolve());
            });
        },
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Downloads a URL into memory, with a per-attempt timeout and retries on network errors
 * and 5xx responses (4xx responses fail immediately).
 * @param {string} url
 * @param {{timeoutMs?:number, retries?:number, fetchImpl?:typeof fetch}} [opts]
 * @returns {Promise<Buffer>}
 */
export async function download(url, { timeoutMs = 120000, retries = 2, fetchImpl = globalThis.fetch } = {}) {
    for (let attempt = 0; ; attempt++) {
        let res;
        try {
            res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
        } catch (err) {
            if (attempt >= retries) throw new Error(`download failed for ${url}: ${err.message}`, { cause: err });
            await sleep(800 * 2 ** attempt);
            continue;
        }
        if (res.ok) return Buffer.from(await res.arrayBuffer());
        if (res.status < 500 || attempt >= retries) throw new Error(`HTTP ${res.status} for ${url}`);
        await sleep(800 * 2 ** attempt);
    }
}
