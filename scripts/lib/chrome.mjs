// Headless Chrome/Edge launcher + a minimal Chrome DevTools Protocol client (zero deps).
//
// Uses --remote-debugging-port=0 and reads the chosen port from DevToolsActivePort, so
// parallel runs never collide. The client speaks to the BROWSER endpoint and attaches to a
// page with flattened sessions, which lets it close the browser cleanly via Browser.close.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Finds a Chromium-based browser: $CHROME_PATH, then the usual install locations, then PATH.
 * @returns {string|null}
 */
export function findChrome() {
    const candidates = [
        process.env.CHROME_PATH,
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    ].filter(Boolean);
    const found = candidates.find((p) => fs.existsSync(p));
    if (found) return found;
    if (process.platform !== 'win32') {
        for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
            try {
                const p = execFileSync('which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
                if (p) return p;
            } catch { /* not on PATH */ }
        }
    }
    return null;
}

/**
 * Launches headless Chrome with SwiftShader WebGL and returns its DevTools endpoint.
 * @param {{executable:string, width:number, height:number, hostRules?:string|null, extraArgs?:string[], timeoutMs?:number}} opts
 * @returns {Promise<{proc:import('node:child_process').ChildProcess, wsUrl:string, profile:string, kill:()=>Promise<void>}>}
 */
export async function launchChrome({ executable, width, height, hostRules = null, extraArgs = [], timeoutMs = 20000,
    gpu = false, headed = false, angle = null }) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-smoke-'));
    const args = [
        ...(headed ? [] : ['--headless=new']),
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--disable-default-apps', '--disable-extensions',
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-pings',
        '--metrics-recording-only', '--mute-audio', '--hide-scrollbars',
        '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication',
        '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
        // WebGL2 through SwiftShader: deterministic and available on GPU-less CI machines.
        // `gpu` uses the machine's real GPU instead, to reproduce driver-specific artefacts.
        ...(gpu
            ? ['--enable-gpu', '--ignore-gpu-blocklist',
                ...(angle ? [`--use-angle=${angle}`] : process.platform === 'win32' ? ['--use-angle=d3d11'] : [])]
            : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']),
        `--window-size=${width},${height}`,
        ...(hostRules ? [`--host-resolver-rules=${hostRules}`] : []),
        // Ubuntu ≥ 23.10 runners restrict unprivileged user namespaces (no usable sandbox).
        ...(process.platform === 'linux' && (process.env.CI || process.getuid?.() === 0) ? ['--no-sandbox'] : []),
        ...extraArgs,
        'about:blank',
    ];
    const proc = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    let exited = false;
    proc.on('exit', () => { exited = true; });

    const portFile = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;
    let wsUrl = null;
    while (!wsUrl && Date.now() < deadline && !exited) {
        await sleep(100);
        try {
            const [port, wsPath] = fs.readFileSync(portFile, 'utf8').split('\n');
            if (port && wsPath) wsUrl = `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
        } catch { /* not written yet */ }
    }
    const kill = async () => {
        if (!exited) {
            proc.kill();
            for (let i = 0; i < 30 && !exited; i++) await sleep(100);
        }
        for (let i = 0; i < 10; i++) {   // Windows keeps profile files locked for a moment
            try {
                fs.rmSync(profile, { recursive: true, force: true });
                break;
            } catch {
                await sleep(200);
            }
        }
    };
    if (!wsUrl) {
        await kill();
        throw new Error(`browser did not expose a DevTools endpoint${stderr ? `:\n${stderr.trim()}` : ''}`);
    }
    return { proc, wsUrl, profile, kill };
}

/**
 * Minimal CDP client over the browser WebSocket (Node ≥ 22 has a global WebSocket).
 * `send(method, params, sessionId?)`; events are dispatched to `on(method, fn)` with
 * `(params, sessionId)`.
 */
export class CdpClient {
    /** @param {string} wsUrl */
    static async connect(wsUrl) {
        const ws = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true });
        });
        return new CdpClient(ws);
    }

    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Map();
        ws.addEventListener('message', (ev) => this.#onMessage(ev));
        ws.addEventListener('close', () => {
            for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'));
            this.pending.clear();
        });
    }

    #onMessage(ev) {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
        if (msg.id !== undefined) {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
            else p.resolve(msg.result);
            return;
        }
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
    }

    /**
     * @param {string} method
     * @param {object} [params]
     * @param {string} [sessionId]
     * @returns {Promise<any>}
     */
    send(method, params = {}, sessionId = undefined) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, method });
            this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
        });
    }

    /** @param {string} method @param {(params:any, sessionId?:string)=>void} fn */
    on(method, fn) {
        if (!this.listeners.has(method)) this.listeners.set(method, []);
        this.listeners.get(method).push(fn);
    }

    close() {
        try {
            this.ws.close();
        } catch { /* already closed */ }
    }
}
