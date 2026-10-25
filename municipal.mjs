// TSE EA15 identifies changed municipalities; EA20 supplies candidate votes.
// Official specification: https://www.tse.jus.br/eleicoes/informacoes-tecnicas-sobre-a-divulgacao-de-resultados
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const UFS = 'ac al ap am ba ce df es go ma mt ms mg pa pb pr pe pi rj rn rs ro rr sc sp se to zz'.split(' ');
const BASE = 'https://resultados.tse.jus.br/oficial/ele2026/6258/dados';
const number = value => value === null || value === undefined || value === '' ? NaN : Number(String(value).replace(',', '.'));
const errorText = e => String(e?.message || e).slice(0, 300);
async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path + '.tmp', JSON.stringify(value) + '\n');
  await rename(path + '.tmp', path);
}
async function parallel(items, operation) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; await operation(items[i]); }
  }));
}
class SkippedRequest extends Error {}
// TSE timestamps are compared in their own common civil timezone, not to host time.
export function tseStamp(date, time) {
  if (!date && !time) return '';
  const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(date));
  if (!d || !/^\d{2}:\d{2}:\d{2}$/.test(String(time))) throw Error('Data/hora TSE inválida');
  return `${d[3]}-${d[2]}-${d[1]}T${time}`;
}
function election(body) {
  if (!body || typeof body !== 'object' || String(body.ele) !== '6258' || String(body.t) !== '2' || body.f !== 'o')
    throw Error('Eleição municipal incompatível');
}
function sections(s) {
  const total = number(s?.ts), counted = number(s?.st);
  if (!Number.isInteger(total) || total < 0 || !Number.isInteger(counted) || counted < 0 || counted > total)
    throw Error('Contagem municipal de seções inválida');
}
export function validateIndex(body, uf) {
  election(body);
  if (!Array.isArray(body.abr) || !body.abr.length) throw Error('Índice municipal vazio');
  const rows = body.abr.filter(x => x.tpabr === 'mun');
  if (!rows.length || body.abr.some(x => x.tpabr === 'uf' && String(x.cdabr).toLowerCase() !== uf))
    throw Error('Índice municipal de UF incompatível');
  const seen = new Set();
  for (const row of rows) {
    if (!/^\d{5}$/.test(String(row.cdabr)) || seen.has(row.cdabr)) throw Error('Código municipal inválido ou duplicado');
    seen.add(row.cdabr); sections(row.s); tseStamp(row.dt, row.ht);
  }
  return rows;
}
export function validateMunicipal(body, entry) {
  election(body);
  if (String(body.cdabr) !== entry.code || !['mu', 'mun'].includes(body.tpabr)) throw Error('Abrangência municipal incompatível');
  sections(body.s);
  if (number(body.s.ts) <= 0) throw Error('Município sem total de seções positivo');
  const cargo = body.carg?.find(c => String(c.cd) === '1');
  const candidates = (cargo?.agr || []).flatMap(a => (a.par || []).flatMap(p => p.cand || []));
  if (!cargo || !candidates.length || candidates.some(c => !Number.isInteger(number(c.vap)) || number(c.vap) < 0) ||
      !Number.isInteger(number(body.v?.vv)) || number(body.v.vv) < 0) throw Error('Votação presidencial municipal inválida');
  const generated = tseStamp(body.dg, body.hg), totalized = tseStamp(body.dt, body.ht);
  if (entry.expectedStamp && (!generated || generated < entry.expectedStamp || !totalized || totalized < entry.expectedStamp))
    throw Error('CDN municipal ainda anterior à atualização indicada pelo EA15');
  return body;
}

export async function collectMunicipal({ dataDir, fetchImpl = fetch, now = Date.now, maxMunicipal = 600,
  tseBlockedUntil = null, maxDurationMs = 25000, isBlocked = () => false, onBlocked = () => {} }) {
  const deadline = Date.now() + maxDurationMs;
  const statePath = resolve(dataDir, 'data/municipal-state.json');
  const old = await readJson(statePath);
  const state = old?.electionId === '6258' ? old : { schemaVersion: 1, electionId: '6258', entries: {}, cursor: 0 };
  const attemptedAt = new Date(now()).toISOString(), errors = [];
  let blockedUntil = typeof tseBlockedUntil === 'number' ? tseBlockedUntil : Date.parse(tseBlockedUntil) || 0;
  if (blockedUntil > now()) return { ...state.summary, lastAttemptAt: attemptedAt,
    skipped: true, complete: false, tseBlockedUntil: new Date(blockedUntil).toISOString(),
    errors: [{ source: 'tse-index', error: 'TSE em pausa após bloqueio HTTP' }] };
  let nextStart = 0, manifestSuccessful = 0, updatedMunicipalities = 0, requestedMunicipalities = 0;
  const stopped = () => blockedUntil > now() || isBlocked() || Date.now() >= deadline;
  async function get(url, started = () => {}) {
    if (stopped()) throw new SkippedRequest('Prazo do ciclo ou pausa TSE');
    // Reserve starts synchronously: at most 20 requests/second, max 8 in flight.
    const wait = Math.max(0, nextStart - Date.now());
    nextStart = Math.max(nextStart, Date.now()) + 50;
    if (wait) await delay(Math.min(wait, Math.max(0, deadline - Date.now())));
    if (stopped()) throw new SkippedRequest('Prazo do ciclo ou pausa TSE');
    started();
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(8000, deadline - Date.now()))), cache: 'no-store',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'elections-monitor-2026/1.0' } });
    if (response.status === 403 || response.status === 429) { blockedUntil = now() + 600_000; onBlocked(); }
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    return response.json();
  }
  await parallel(UFS, async uf => {
    try {
      const rows = validateIndex(await get(`${BASE}/${uf}/${uf}-e006258-ab.json`), uf);
      for (const row of rows) {
        const id = uf + row.cdabr, previous = state.entries[id];
        const stamp = tseStamp(row.dt, row.ht);
        // A lagging index must not roll back the target already observed.
        if (previous && stamp < previous.expectedStamp) continue;
        state.entries[id] = { ...previous, uf, code: row.cdabr, expectedStamp: stamp,
          expectedSections: number(row.s.st), totalSections: number(row.s.ts), indexCheckedAt: new Date(now()).toISOString() };
      }
      manifestSuccessful++;
    } catch (e) { if (!(e instanceof SkippedRequest)) errors.push({ source: `tse-index/${uf}`, error: errorText(e) }); }
  });
  const pending = () => Object.keys(state.entries).filter(id => {
    const e = state.entries[id];
    return !e.available || e.fulfilledStamp !== e.expectedStamp || e.fulfilledSections !== e.expectedSections;
  }).sort();
  const queue = pending();
  // Failed or CDN-lagging municipalities cannot monopolize the next cycle.
  const start = queue.length ? (state.cursor || 0) % queue.length : 0;
  const ordered = [...queue.slice(start), ...queue.slice(0, start)];
  const selected = ordered.slice(0, Math.max(0, Math.min(600, maxMunicipal)));
  await parallel(selected, async id => {
    if (stopped()) return;
    const entry = state.entries[id], path = resolve(dataDir, `data/tse/${id}.json`);
    const sourceUrl = `${BASE}/${entry.uf}/${id}-c0001-e006258-u.json`;
    const previous = await readJson(path);
    try {
      const body = validateMunicipal(await get(sourceUrl, () => requestedMunicipalities++), entry), checkedAt = new Date(now()).toISOString();
      // Section counts can be revised down legitimately; use the official timestamp above.
      if (number(body.s.st) !== entry.expectedSections) throw Error('EA20 e EA15 ainda divergem em seções totalizadas');
      await writeJson(path, { schemaVersion: 1, source: `tse/${id}`, sourceUrl, body,
        checkedAt, lastAttemptAt: attemptedAt, error: null });
      entry.available = true; entry.fulfilledStamp = entry.expectedStamp; entry.fulfilledSections = entry.expectedSections;
      entry.checkedAt = checkedAt; entry.error = null; updatedMunicipalities++;
    } catch (e) {
      if (e instanceof SkippedRequest) return;
      const error = errorText(e); entry.error = error;
      await writeJson(path, { schemaVersion: 1, source: `tse/${id}`, sourceUrl, body: previous?.body ?? null,
        checkedAt: previous?.checkedAt ?? null, lastAttemptAt: attemptedAt, error });
      errors.push({ source: `tse/${id}`, error });
    }
  });
  state.cursor = queue.length ? (start + requestedMunicipalities) % queue.length : 0;
  const knownMunicipalities = Object.keys(state.entries).length;
  const availableMunicipalities = Object.values(state.entries).filter(e => e.available).length;
  const pendingMunicipalities = pending().length;
  const summary = { checkedAt: new Date(now()).toISOString(), lastAttemptAt: attemptedAt,
    knownMunicipalities, availableMunicipalities, updatedMunicipalities, requestedMunicipalities,
    pendingMunicipalities, manifestSuccessful, manifestExpected: UFS.length, errors,
    tseBlockedUntil: blockedUntil > now() ? new Date(blockedUntil).toISOString() : null,
    pauseUntil: blockedUntil > now() ? new Date(blockedUntil).toISOString() : null,
    deadlineReached: Date.now() >= deadline,
    complete: manifestSuccessful === UFS.length && knownMunicipalities > 0 && pendingMunicipalities === 0 && !errors.length };
  state.summary = summary;
  await writeJson(statePath, state);
  return summary;
}
