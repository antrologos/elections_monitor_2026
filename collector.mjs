import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { collectMunicipal } from './municipal.mjs';

export const ELECTION = { year: 2026, round: 2, electionId: '6258', office: 'president' };
export const UFS = 'ac al ap am ba ce df es go ma mt ms mg pa pb pr pe pi rj rn rs ro rr sc sp se to zz'.split(' ');
export const SOURCES = [
  ...['br', ...UFS].map(id => ({ id: `tse/${id}`, kind: 'tse', territory: id,
    url: `https://resultados.tse.jus.br/oficial/ele2026/6258/dados/${id}/${id}-c0001-e006258-u.json` })),
  { id: 'pet', kind: 'pet', url: 'https://petapura.eleicoes-pet.workers.dev/data/latest.json' },
];
const STABLE_MS = 30 * 60_000;
const number = value => value === null || value === undefined || value === '' ? NaN : Number(String(value).replace(',', '.'));
const iso = ms => new Date(ms).toISOString();
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const message = error => String(error?.message || error).slice(0, 300);

export function validate(source, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Documento JSON inválido');
  if (source.kind === 'tse') {
    if (String(body.ele) !== ELECTION.electionId || String(body.t) !== '2' || body.f !== 'o' ||
        String(body.cdabr).toLowerCase() !== source.territory) throw Error('Eleição ou abrangência oficial incompatível');
    const total = number(body.s?.ts), counted = number(body.s?.st);
    if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(counted) || counted < 0 || counted > total)
      throw Error('Contagem de seções oficial inválida');
    const cargo = body.carg?.find(c => String(c.cd) === '1');
    if (!cargo) throw Error('Cargo presidencial ausente');
    const valid = number(body.v?.vv);
    if (!Number.isInteger(valid) || valid < 0) throw Error('Total de votos válidos inválido');
    const candidates = (cargo.agr || []).flatMap(a => (a.par || []).flatMap(p => p.cand || []));
    if (!candidates.length || candidates.some(c => !Number.isInteger(number(c.vap)) || number(c.vap) < 0))
      throw Error('Votos dos candidatos inválidos');
  } else {
    if (body.mode !== 'live' || Number(body.election?.year) !== 2026 || Number(body.election?.round) !== 2 ||
        String(body.election?.election_id) !== ELECTION.electionId || body.election?.office !== 'president')
      throw Error('PET não publica a eleição esperada em modo ao vivo');
    if (String(body.candidates?.a?.id) !== '13' || String(body.candidates?.b?.id) !== '22')
      throw Error('Candidatos PET incompatíveis');
    if (!Number.isFinite(Date.parse(body.forecast?.generated_at)) ||
        !Number.isFinite(number(body.forecast?.share_a)) || number(body.forecast.share_a) < 0 || number(body.forecast.share_a) > 100)
      throw Error('Projeção PET inválida');
    if (Date.parse(body.forecast.generated_at) > Date.now() + 120_000) throw Error('Projeção PET com horário futuro');
    const count = number(body.counting?.collected_sections ?? body.counting?.reported_sections);
    const total = number(body.counting?.total_sections);
    if (!Number.isInteger(count) || !Number.isInteger(total) || total <= 0 || count < 0 || count > total)
      throw Error('Cobertura PET inválida');
    if (body.history !== undefined && !Array.isArray(body.history)) throw Error('Histórico PET inválido');
  }
  return body;
}

export function envelope(source, previous, outcome, attemptedAt) {
  if (outcome.ok) return { schemaVersion: 1, source: source.id, sourceUrl: source.url,
    body: outcome.body, checkedAt: outcome.checkedAt, lastAttemptAt: attemptedAt, error: null };
  return { schemaVersion: 1, source: source.id, sourceUrl: source.url,
    body: previous?.body ?? null, checkedAt: previous?.checkedAt ?? null,
    lastAttemptAt: attemptedAt, error: outcome.error };
}

export async function fetchSource(source, fetchImpl = fetch, onBlocked = () => {}) {
  let failure;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(source.url, { signal: AbortSignal.timeout(8000), cache: 'no-store',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'elections-monitor-2026/1.0' } });
      if (response.status === 403 || response.status === 429) {
        if (source.kind === 'tse') onBlocked();
        return { ok: false, error: source.kind === 'tse' ? `HTTP ${response.status}: consultas TSE suspensas por dez minutos` : `HTTP ${response.status}` };
      }
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const body = validate(source, await response.json());
      return { ok: true, body, checkedAt: new Date().toISOString() };
    } catch (error) { failure = message(error); if (attempt === 0) await delay(500); }
  }
  return { ok: false, error: failure };
}

export function completion(previous, national, allSucceeded, now) {
  const pending = { completed: false, status: 'collecting', since: null, completedAt: null,
    criterion: 'Brasil: todas as seções totalizadas; resultado inalterado e todas as fontes consultáveis por 30 minutos.' };
  if (!national?.ok) return previous?.completed ? previous : pending;
  const b = national.body, total = number(b.s?.ts), counted = number(b.s?.st);
  if (!Number.isInteger(total) || total <= 0 || counted !== total) return pending;
  const cargo = b.carg.find(c => String(c.cd) === '1');
  const candidates = (cargo.agr || []).flatMap(a => (a.par || []).flatMap(p => p.cand || []))
    .map(c => [String(c.n), String(c.vap)]).sort((a, b) => a[0].localeCompare(b[0]));
  const fingerprint = sha({ total, counted, valid: b.v.vv, candidates });
  if (previous?.completed && previous.fingerprint === fingerprint) return previous;
  if (!allSucceeded) return pending;
  const oldSince = Date.parse(previous?.since);
  const lastSuccess = Date.parse(previous?.lastSuccessfulCycleAt);
  const consecutive = Number.isFinite(lastSuccess) && now >= lastSuccess && now - lastSuccess <= 180_000;
  const since = consecutive && previous?.fingerprint === fingerprint && Number.isFinite(oldSince) && oldSince <= now ? oldSince : now;
  const done = now - since >= STABLE_MS;
  return { ...pending, fingerprint, since: iso(since), lastSuccessfulCycleAt: iso(now), completed: done,
    status: done ? 'completed' : 'stabilizing', completedAt: done ? iso(now) : null };
}

async function json(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomicJson(path, body) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(body) + '\n');
  await rename(`${path}.tmp`, path);
}
async function parallel(items, concurrency, operation) {
  const results = new Array(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; results[i] = await operation(items[i]); }
  }));
  return results;
}

export async function collectCycle({ dataDir, fetchImpl = fetch, now = Date.now, runUrl = null, includeMunicipal = false }) {
  const previous = await json(resolve(dataDir, 'data/heartbeat.json'));
  const attemptedAt = iso(now());
  let tseBlockedUntil = Date.parse(previous?.tseBlockedUntil) || 0;
  const outcomes = await parallel(SOURCES, 8, source => {
    if (source.kind === 'tse' && tseBlockedUntil > now())
      return { ok: false, error: `TSE em pausa por bloqueio HTTP até ${iso(tseBlockedUntil)}` };
    return fetchSource(source, fetchImpl, () => { tseBlockedUntil = now() + 600_000; });
  });
  for (let i = 0; i < SOURCES.length; i++) {
    const source = SOURCES[i], path = resolve(dataDir, `data/${source.id}.json`);
    await atomicJson(path, envelope(source, await json(path), outcomes[i], attemptedAt));
  }
  let municipal = previous?.municipal ?? null;
  if (includeMunicipal) {
    try {
      municipal = await collectMunicipal({ dataDir, fetchImpl, now, maxMunicipal: 600,
        maxDurationMs: 25_000, budgetMs: 25_000,
        isBlocked: () => tseBlockedUntil > now(), onBlocked: () => { tseBlockedUntil = now() + 600_000; } });
    } catch (error) {
      municipal = { ...municipal, complete: false, lastAttemptAt: attemptedAt,
        errors: [{ source: 'municipal-collector', error: message(error) }] };
    }
  }
  const successfulSources = outcomes.filter(x => x.ok).length, finished = now();
  const status = completion(previous?.completion, outcomes[0], successfulSources === SOURCES.length && (!includeMunicipal || municipal?.complete), finished);
  const heartbeat = { schemaVersion: 1, election: ELECTION, collectionMode: 'github-actions',
    checkedAt: successfulSources ? iso(finished) : previous?.checkedAt ?? null,
    lastAttemptAt: attemptedAt, cycleFinishedAt: iso(finished), runUrl,
    tseBlockedUntil: tseBlockedUntil > finished ? iso(tseBlockedUntil) : null,
    successfulSources, expectedSources: SOURCES.length,
    errors: outcomes.flatMap((outcome, i) => outcome.ok ? [] : [{ source: SOURCES[i].id, error: outcome.error }]),
    completion: status, intervalSeconds: status.completed ? 300 : 60,
    coverage: { national: true, states: 27, abroad: true, municipalities: includeMunicipal }, municipal,
    modelsExecuted: [], note: 'Coleta TSE e republicação integral da projeção pública PET. Não executa os modelos Rodrigo ou Histórico e Espacial.' };
  await atomicJson(resolve(dataDir, 'data/heartbeat.json'), heartbeat);
  return heartbeat;
}

export function gitPublish(dataDir, timestamp) {
  const git = args => execFileSync('git', args, { cwd: dataDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['add', '--', 'data']);
  if (git(['status', '--porcelain']).trim())
    git(['-c', 'user.name=elections-monitor[bot]', '-c', 'user.email=elections-monitor[bot]@users.noreply.github.com',
      'commit', '-m', `Coleta ${timestamp}`]);
  // No forced push: code lives on main and data is serialized by workflow concurrency.
  git(['push', 'origin', 'HEAD:refs/heads/data']);
}

export async function main(args = process.argv.slice(2)) {
  const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
  const dataDir = resolve(option('--data-dir', '.'));
  const duration = Number(option('--duration-minutes', '330'));
  if (!(duration > 0 && duration <= 330)) throw Error('Duração deve estar entre 0 e 330 minutos');
  const publish = args.includes('--publish'), once = args.includes('--once');
  const deadline = Date.now() + duration * 60_000;
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
  let stopping = false;
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  while (!stopping && Date.now() < deadline) {
    const start = Date.now(), heartbeat = await collectCycle({ dataDir, runUrl, includeMunicipal: true });
    if (publish) {
      let published = false;
      for (let attempt = 0; attempt < 3 && !published; attempt++) {
        try {
          gitPublish(dataDir, heartbeat.lastAttemptAt);
          published = true;
        } catch {
          if (attempt === 2) throw Error('Falha ao persistir snapshots no branch data após três tentativas.');
          await delay(5000);
        }
      }
    }
    console.log(JSON.stringify({ checkedAt: heartbeat.checkedAt, successfulSources: heartbeat.successfulSources,
      expectedSources: heartbeat.expectedSources, completion: heartbeat.completion.status, persisted: publish }));
    if (once || heartbeat.completion.completed || stopping) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(Math.max(0, 60_000 - (Date.now() - start)), remaining));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(message(error)); process.exitCode = 1; });
