#!/usr/bin/env node
// Zero-dependency dev server for the static site (`npm start`).
//
//   node scripts/serve.mjs [--port=8080] [--host=127.0.0.1] [--subpath=/planet-location-marker/] [--quiet]
//
// Serves the repo root with correct MIME types (incl. .mjs, .svg, .webmanifest) and
// `Cache-Control: no-store`, so edits show up on reload. If the port is taken it tries the
// next ten. `--subpath` mounts the site under a prefix exactly like GitHub Pages does — any
// absolute URL in the app then 404s, which catches SPEC R4 violations early.
// Use --host=0.0.0.0 to test from a phone on the same network.

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from './lib/http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.port ?? process.env.PORT ?? 8080);
const HOST = args.host ?? '127.0.0.1';
const quiet = args.quiet === 'true';

const app = createStaticServer(ROOT, {
    prefix: args.subpath,
    log: quiet ? null : (line) => {
        const [status] = line.split(' ');
        if (status !== '200' || args.verbose === 'true') console.log(`  ${line}`);
    },
});

let url = null;
for (let port = PORT; port < PORT + 10 && !url; port++) {
    try {
        url = await app.listen(port, HOST);
    } catch (err) {
        if (err.code !== 'EADDRINUSE') throw err;
        console.warn(`port ${port} is in use, trying ${port + 1}…`);
    }
}
if (!url) {
    console.error(`no free port in ${PORT}–${PORT + 9}`);
    process.exit(1);
}

console.log(`Planet Location Marker dev server → ${url.replace('127.0.0.1', 'localhost')}`);
if (HOST === '0.0.0.0') {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (lan) console.log(`on your network     → ${url.replace('localhost', lan.address)}`);
}
console.log('(no-store caching; 404s and errors are logged; Ctrl+C to stop)');

const stop = async () => {
    await app.close();
    process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
