// The 'Copy diagnostics' report (context-loss-backoff-and-diagnostics): a fixed shape, the last 20
// errors, and never the observer's place.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagnostics, diagHash, scrubError, DIAG_MAX_ERRORS } from '../js/core/diagnostics.js';

const HASH = '#loc=21.0285,105.8542&n=Hanoi&cc=VN&tz=Asia/Ho_Chi_Minh&el=15&t=2027-08-02T10:07:00Z&r=3600&p=1'
    + '&view=orbit&lock=1&sel=moon&ly=bgoscCnmkazhldxw&q=high&cam=o:21.0,105.8,3.2&loc2=48.85,2.35&n2=Paris&tz2=Europe/Paris'
    + '&host=mars&hloc=18.44,77.45';

test('diagnostics: the hash keeps its view settings and drops every place', () => {
    const h = diagHash(HASH);
    assert.deepEqual(h, { t: '2027-08-02T10:07:00Z', r: '3600', p: '1', view: 'orbit', lock: '1', sel: 'moon', ly: 'bgoscCnmkazhldxw', q: 'high', host: 'mars' });
    assert.deepEqual(diagHash(''), {});
});

test('diagnostics: no latitude, longitude, place name or zone anywhere in the report', () => {
    const report = buildDiagnostics({
        version: '2.0.0', nowMs: Date.UTC(2026, 10, 4), hash: HASH,
        decision: { tier: 'high', ceiling: 'high', reason: 'discrete-gpu' }, quality: { setting: 'auto', active: 'medium' },
        errors: ['TypeError: x is undefined\n  at http://127.0.0.1:8080/js/main.js?v=2:10:5',
            'Error: could not open http://127.0.0.1:8080/#loc=21.0285,105.8542&n=Hanoi', 'loc=21.0285,105.8542 cam=o:21.0,105.8,3.2'],
        stats: { fps: 60, tier: 'medium' },
    });
    const json = JSON.stringify(report);
    for (const bad of ['21.0', '105.8', 'Hanoi', 'Ho_Chi_Minh', 'Paris', '48.85', '18.44', '77.45', 'VN']) {
        assert.ok(!json.includes(bad), `${bad} leaked: ${json}`);
    }
    assert.equal(report.tier.decision.reason, 'discrete-gpu');
    assert.equal(report.tier.active, 'medium');
    assert.match(report.errors[0], /main\.js\?:10:5/);
});

test('diagnostics: the newest 20 errors, trimmed; an empty input still has the full shape', () => {
    const errors = Array.from({ length: 30 }, (_, i) => `e${i} ${'x'.repeat(2000)}`);
    const r = buildDiagnostics({ errors });
    assert.equal(r.errors.length, DIAG_MAX_ERRORS);
    assert.ok(r.errors[0].startsWith('e10 '));
    assert.ok(r.errors.every((e) => e.length <= 800));
    const empty = buildDiagnostics();
    assert.deepEqual(Object.keys(empty), ['app', 'tier', 'device', 'modules', 'contextLosses', 'errors', 'stats', 'hash']);
    assert.deepEqual(empty.contextLosses, { count: 0, cap: null, textMode: false });
    assert.equal(empty.app.sw, null);
    // The deploy the report comes from: the service worker's version, and a newer one waiting.
    const sw = buildDiagnostics({ sw: { version: '2.0.0+0123456789abcdef', controlled: true, waiting: null, precached: true } }).app.sw;
    assert.deepEqual(sw, { version: '2.0.0+0123456789abcdef', controlled: true, waiting: null });
    assert.equal(scrubError(null), '');
});
