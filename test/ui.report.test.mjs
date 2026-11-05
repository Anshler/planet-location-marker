// 'Report a problem' (About): the prefilled new-issue link is built from REPO_URL and carries no report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { issueUrl } from '../js/ui/report.js';
import { REPO_URL, VERSION } from '../js/version.js';

test('issueUrl: a new issue on the repository with a template and the version', () => {
    const url = new URL(issueUrl());
    assert.equal(`${url.origin}${url.pathname}`, `${REPO_URL}/issues/new`);
    const body = url.searchParams.get('body');
    assert.match(body, /What happened\?/);
    assert.match(body, /Copy diagnostics/);
    assert.ok(body.includes(VERSION));
    assert.deepEqual([...url.searchParams.keys()], ['body'], 'nothing else: the user pastes the diagnostics');
});
