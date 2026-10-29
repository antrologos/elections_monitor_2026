import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, safeError } from './process.mjs';
import { appendFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
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

export async function fetchSource(source, fetchImpl = fetch, onBlocked = () => {}, signal) {
  let failure;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    try {
      const response = await fetchImpl(source.url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000), cache: 'no-store',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'elections-monitor-2026/1.0' } });
      if (response.status === 403 || response.status === 429) {
        if (source.kind === 'tse') onBlocked();
        return { ok: false, error: source.kind === 'tse' ? `HTTP ${response.status}: consultas TSE suspensas por dez minutos` : `HTTP ${response.status}` };
      }
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const body = validate(source, await response.json());
      return { ok: true, body, checkedAt: new Date().toISOString() };
    } catch (error) { failure = message(error); if (attempt === 0) await delay(500, undefined, {signal}); }
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

export async function collectCycle({ dataDir, fetchImpl = fetch, now = Date.now, runUrl = null, includeMunicipal = false, signal, onProgress = () => {} }) {
  signal?.throwIfAborted();
  onProgress('sources');
  const previous = await json(resolve(dataDir, 'data/heartbeat.json'));
  const attemptedAt = iso(now());
  let tseBlockedUntil = Date.parse(previous?.tseBlockedUntil) || 0;
  const outcomes = await parallel(SOURCES, 8, source => {
    if (source.kind === 'tse' && tseBlockedUntil > now())
      return { ok: false, error: `TSE em pausa por bloqueio HTTP até ${iso(tseBlockedUntil)}` };
    return fetchSource(source, fetchImpl, () => { tseBlockedUntil = now() + 600_000; }, signal);
  });
  for (let i = 0; i < SOURCES.length; i++) {
    const source = SOURCES[i], path = resolve(dataDir, `data/${source.id}.json`);
    await atomicJson(path, envelope(source, await json(path), outcomes[i], attemptedAt));
  }
  let municipal = previous?.municipal ?? null;
  if (includeMunicipal) {
    try {
      onProgress('municipal');
      municipal = await collectMunicipal({ dataDir, fetchImpl, now, signal, maxMunicipal: 600,
        maxDurationMs: 25_000, budgetMs: 25_000,
        isBlocked: () => tseBlockedUntil > now(), onBlocked: () => { tseBlockedUntil = now() + 600_000; } });
    } catch (error) {
      municipal = { ...municipal, complete: false, lastAttemptAt: attemptedAt,
        errors: [{ source: 'municipal-collector', error: message(error) }] };
    }
  }
  signal?.throwIfAborted();
  onProgress('persist_local');
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

export async function gitPublish(dataDir, timestamp, { signal, timeoutMs=15000, onEvent } = {}) {
  const git = async args => (await runCommand('git',args,{cwd:dataDir,timeoutMs,signal,onEvent})).stdout;
  await git(['add','--','data']);
  if ((await git(['status','--porcelain','--','data'])).trim())
    await git(['-c','user.name=elections-monitor[bot]','-c','user.email=elections-monitor[bot]@users.noreply.github.com',
      'commit','-m',`Coleta ${timestamp}`,'--','data']);
  await git(['push','origin','HEAD:refs/heads/data']);
}

export async function main(args = process.argv.slice(2), { fetchImpl=fetch, publishImpl=gitPublish, collectImpl=collectCycle } = {}) {
  const options=new Map();
  const allowed=new Set(['--data-dir','--duration-minutes','--wall-timeout-seconds','--publish','--once']);
  for(let i=0;i<args.length;i++){
    const name=args[i];
    if(!allowed.has(name))throw Error(`Unknown option: ${name}`);
    if(options.has(name))throw Error(`Duplicate option: ${name}`);
    if(['--publish','--once'].includes(name)){options.set(name,true);continue;}
    const value=args[++i];
    if(!value||value.startsWith('--'))throw Error(`Missing value for ${name}`);
    options.set(name,value);
  }
  const option=(name,fallback)=>options.get(name)??fallback;
  const dataDir=resolve(option('--data-dir','.'));
  const duration=Number(option('--duration-minutes','1'));
  const wall=Number(option('--wall-timeout-seconds','90'));
  if(!(duration>0&&duration<=5&&wall>0&&wall<=360))throw Error('Duração máxima: 5 minutos; limite total: 360 segundos');
  const once=args.includes('--once')||!args.includes('--duration-minutes'),publish=args.includes('--publish');
  const runtime=resolve(dataDir,'.runtime');mkdirSync(runtime,{recursive:true});
  const statusFile=resolve(runtime,'status.json'),eventFile=resolve(runtime,'events.jsonl');
  const began=performance.now(),controller=new AbortController();
  let state={schemaVersion:1,runId:`${Date.now()}-${process.pid}`,pid:process.pid,state:'running',phase:'starting',
    startedAt:new Date().toISOString(),cycles:0,publishRequested:publish,lastError:null};
  const record=(event,fields={})=>{
    state={...state,...fields,updatedAt:new Date().toISOString(),elapsedSeconds:(performance.now()-began)/1000,event};
    writeFileSync(statusFile+'.tmp',JSON.stringify(state)+'\n');renameSync(statusFile+'.tmp',statusFile);
    const line=JSON.stringify({event,...state});appendFileSync(eventFile,line+'\n');console.log(line);
  };
  const stop=()=>controller.abort(Error('Cancelled by signal'));
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  const deadline=setTimeout(()=>controller.abort(Error('Run wall-time limit exceeded')),wall*1000);
  const pulse=setInterval(()=>record('heartbeat'),5000);
  const runUrl=process.env.GITHUB_RUN_ID?`${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`:null;
  record('run_started');
  try {
    do {
      controller.signal.throwIfAborted();
      const cycleStart=performance.now();
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(Math.min(75000,wall*1000))]);
      const heartbeat=await collectImpl({dataDir,fetchImpl,runUrl,includeMunicipal:true,signal,
        onProgress:phase=>record('phase_changed',{phase})});
      if(publish){
        record('phase_changed',{phase:'publishing'});
        // Retries retain the original error and share the run deadline.
        for(let attempt=1;attempt<=3;attempt++){
          controller.signal.throwIfAborted();
          try{await publishImpl(dataDir,heartbeat.lastAttemptAt,{signal:controller.signal,
            onEvent:e=>record(e.event,{lastCommand:e})});break;}
          catch(error){record('publish_failed',{attempt,lastError:safeError(error),commandResult:error.result?
            {...error.result,stdout:undefined,stderr:safeError(error.result.stderr)}:null});
            if(attempt===3||error.result?.reason||controller.signal.aborted)throw error;
            await delay(1000,undefined,{signal:controller.signal});}
        }
      }
      record('cycle_finished',{cycles:state.cycles+1,phase:'cycle_complete',successfulSources:heartbeat.successfulSources,
        expectedSources:heartbeat.expectedSources,lastSuccessfulCollectionAt:heartbeat.checkedAt});
      if(heartbeat.successfulSources!==heartbeat.expectedSources||heartbeat.municipal?.errors?.length)
        throw Error(`Incomplete collection: ${JSON.stringify({sources:heartbeat.errors,municipal:heartbeat.municipal?.errors}).slice(0,12000)}`);
      if(once||heartbeat.completion.completed||performance.now()-began>=duration*60000)break;
      record('phase_changed',{phase:'waiting_for_next_cycle'});
      await delay(Math.min(Math.max(0,60000-(performance.now()-cycleStart)),Math.max(0,duration*60000-(performance.now()-began))),undefined,{signal:controller.signal});
    }while(performance.now()-began<duration*60000);
    record('run_finished',{state:'succeeded',phase:'finished',lastError:null});
    return state;
  }catch(error){
    const timedOut=controller.signal.reason?.message==='Run wall-time limit exceeded'||error.name==='TimeoutError';
    record('run_finished',{state:timedOut?'timed_out':controller.signal.aborted?'stopped':'failed',
      failedPhase:state.phase,phase:'finished',lastError:safeError(controller.signal.reason||error)});
    throw error;
  }finally{
    clearTimeout(deadline);clearInterval(pulse);process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
