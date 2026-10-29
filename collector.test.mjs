import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SOURCES, validate, envelope, completion, fetchSource, collectCycle, gitPublish } from './collector.mjs';

const official = (territory = 'br', counted = 100) => ({ ele: '6258', t: '2', f: 'o', cdabr: territory,
  s: { ts: '100', st: String(counted), pst: '100,00' }, v: { vv: '1000' },
  carg: [{ cd: '1', agr: [{ par: [{ cand: [{ n: '13', vap: '510' }, { n: '22', vap: '490' }] }] }] }] });
const pet = () => ({ mode: 'live', election: { year: 2026, round: 2, election_id: '6258', office: 'president' },
  candidates: { a: { id: '13' }, b: { id: '22' } }, counting: { total_sections: 100, collected_sections: 80 },
  forecast: { generated_at: new Date().toISOString(), share_a: 51 },
  history: [{ generated_at: '2026-10-25T20:00:00Z', forecast_a: 50, originalExtraField: 'preserve' }] });
const national = body => ({ ok: true, body });

test('exact election and territory; rounded 100% does not imply completion', () => {
  assert.equal(SOURCES.length, 30);
  assert.throws(() => validate(SOURCES[0], { ...official(), ele: '544' }));
  assert.throws(() => validate(SOURCES[0], { ...official(), cdabr: 'ac' }));
  assert.equal(completion(null, national(official('br', 99)), true, Date.now()).completed, false);
  assert.throws(() => validate(SOURCES[0], { ...official(), s: { ts: '100', st: '101' } }));
});

test('failed fetch preserves last good body and successful timestamp', () => {
  const old = { body: official(), checkedAt: '2026-10-25T20:00:00Z' };
  const next = envelope(SOURCES[0], old, { ok: false, error: 'HTTP 503' }, '2026-10-25T20:01:00Z');
  assert.deepEqual(next.body, old.body);
  assert.equal(next.checkedAt, old.checkedAt);
  assert.equal(next.lastAttemptAt, '2026-10-25T20:01:00Z');
  assert.equal(next.error, 'HTTP 503');
});

test('stable completion requires continuous successful cycles; changes reopen monitoring', () => {
  const start = Date.parse('2026-10-25T20:00:00Z');
  let state = completion(null, national(official()), true, start);
  assert.equal(completion(state, national(official()), true, start + 31 * 60_000).completed, false, 'gap resets timer');
  for (let minute = 1; minute <= 30; minute++) state = completion(state, national(official()), true, start + minute * 60_000);
  assert.equal(state.completed, true);
  assert.equal(completion(state, national(official()), true, start + 35 * 60_000).completed, true);
  const changed = official(); changed.carg[0].agr[0].par[0].cand[0].vap = '511';
  assert.equal(completion(state, national(changed), true, start + 36 * 60_000).completed, false);
  assert.equal(completion(state, national(official('br', 99)), true, start + 36 * 60_000).completed, false);
  assert.equal(completion({ ...state, completed: false }, { ok: false }, false, start + 36 * 60_000).since, null);
});

test('PET rejects mismatched candidates, impossible coverage and future dates', () => {
  const source = SOURCES.at(-1);
  const p = pet(); p.candidates.a.id = '99'; assert.throws(() => validate(source, p));
  const q = pet(); q.counting.collected_sections = 101; assert.throws(() => validate(source, q));
  const r = pet(); r.forecast.generated_at = new Date(Date.now() + 600_000).toISOString(); assert.throws(() => validate(source, r));
});

test('HTTP 429 does not retry and invokes cooldown hook', async () => {
  let requests = 0, blocked = 0;
  const outcome = await fetchSource(SOURCES[0], async () => { requests++; return { ok: false, status: 429 }; }, () => blocked++);
  assert.equal(outcome.ok, false); assert.equal(requests, 1); assert.equal(blocked, 1);
});

test('complete cycle preserves full PET history and failed cycle retains success timestamps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'elections-cycle-'));
  try {
    const payload = pet(), start = Date.now();
    const fake = async url => ({ ok: true, json: async () => url.includes('petapura') ? payload : official(url.split('/').at(-2)) });
    const first = await collectCycle({ dataDir: dir, fetchImpl: fake, now: () => start });
    assert.equal(first.successfulSources, 30); assert.equal(first.intervalSeconds, 60);
    const stored = JSON.parse(await readFile(join(dir, 'data/pet.json'), 'utf8'));
    assert.deepEqual(stored.body.history, payload.history);
    const failed = async () => ({ ok: false, status: 403 });
    const second = await collectCycle({ dataDir: dir, fetchImpl: failed, now: () => start + 60_000 });
    assert.equal(second.successfulSources, 0); assert.equal(second.checkedAt, first.checkedAt);
    assert.equal(second.errors.length, 30); assert.ok(second.tseBlockedUntil);
    const retained = JSON.parse(await readFile(join(dir, 'data/pet.json'), 'utf8'));
    assert.deepEqual(retained.body, payload); assert.equal(retained.checkedAt, stored.checkedAt);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('data commits publish atomically on separate branch and retain previous versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'elections-git-'));
  const bare = join(root, 'remote.git'), local = join(root, 'local');
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(root, ['init', '--bare', bare]); git(root, ['init', local]);
    git(local, ['remote', 'add', 'origin', bare]);
    await mkdir(join(local, 'data')); await writeFile(join(local, 'data/heartbeat.json'), '{"version":1}\n');
    await gitPublish(local, 'first');
    await writeFile(join(local, 'data/heartbeat.json'), '{"version":2}\n');
    await gitPublish(local, 'second'); await gitPublish(local, 'retry-with-clean-tree');
    assert.equal(git(bare, ['rev-list', '--count', 'data']).trim(), '2');
    assert.equal(JSON.parse(git(bare, ['show', 'data:data/heartbeat.json'])).version, 2);
    assert.equal(JSON.parse(git(bare, ['show', 'data~1:data/heartbeat.json'])).version, 1);
    assert.equal(git(bare, ['for-each-ref', '--format=%(refname)']).trim(), 'refs/heads/data');
  } finally { await rm(root, { recursive: true, force: true }); }
});

