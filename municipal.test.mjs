import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectMunicipal, validateMunicipal, validateIndex } from './municipal.mjs';

const body = { ele:'6258', t:'2', f:'o', tpabr:'mu', cdabr:'01007', dg:'25/10/2026', hg:'16:02:00',
  dt:'25/10/2026', ht:'16:01:00', s:{ts:'2',st:'1'}, v:{vv:'100'},
  carg:[{cd:'1',agr:[{par:[{cand:[{vap:'40'},{vap:'60'}]}]}]}] };
const row = { tpabr:'mun', cdabr:'01007', dt:'25/10/2026', ht:'16:01:00', s:{ts:'2',st:'1'} };
const entry = { code:'01007', expectedStamp:'2026-10-25T16:01:00' };
test('municipal validates identity, votes and CDN generation/totalization', () => {
  assert.equal(validateMunicipal(body,entry),body);
  for (const change of [{ele:'6257'},{cdabr:'01008'},{hg:'16:00:00'},{ht:'16:00:00'},
    {v:{vv:'-1'}},{s:{ts:'0',st:'0'}}]) assert.throws(()=>validateMunicipal({...body,...change},entry));
  assert.throws(()=>validateIndex({ele:'6258',t:'2',f:'o',abr:[row,row]},'ac'));
});
test('municipal queues missing areas and preserves prior good data when CDN lags', async () => {
  const dir=await mkdtemp(join(tmpdir(),'municipal-incremental-'));
  try {
    let lag=false;
    const fetchImpl=async url=>({ok:true,json:async()=>url.endsWith('-ab.json')?
      {ele:'6258',t:'2',f:'o',abr:[{...row,ht:lag?'16:03:00':row.ht}]}:structuredClone(body)});
    const first=await collectMunicipal({dataDir:dir,fetchImpl,maxMunicipal:2});
    assert.equal(first.manifestSuccessful,28); assert.equal(first.availableMunicipalities,2);
    assert.equal(first.pendingMunicipalities,26);
    const state=JSON.parse(await readFile(join(dir,'data/municipal-state.json'),'utf8'));
    const fulfilled=Object.keys(state.entries).filter(id=>state.entries[id].available);
    lag=true;
    const second=await collectMunicipal({dataDir:dir,fetchImpl});
    assert.equal(second.updatedMunicipalities,0); assert.equal(second.pendingMunicipalities,28);
    for(const id of fulfilled){
      const env=JSON.parse(await readFile(join(dir,`data/tse/${id}.json`),'utf8'));
      assert.equal(env.body.v.vv,'100'); assert.ok(env.checkedAt); assert.ok(env.error);
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('municipal honors inherited pause and HTTP429 stops new requests', async () => {
  const dir=await mkdtemp(join(tmpdir(),'municipal-pause-'));
  try {
    let requests=0,blocked=0;
    const paused=await collectMunicipal({dataDir:dir,tseBlockedUntil:Date.now()+600000,
      fetchImpl:async()=>{requests++;throw Error('unexpected')}});
    assert.equal(requests,0); assert.equal(paused.skipped,true);
    const out=await collectMunicipal({dataDir:dir,onBlocked:()=>blocked++,
      fetchImpl:async()=>{requests++;return {ok:false,status:429}}});
    assert.equal(requests,1); assert.equal(blocked,1); assert.ok(Date.parse(out.tseBlockedUntil)>Date.now());
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('municipal deadline bounds slow requests and stops queue', async () => {
  const dir=await mkdtemp(join(tmpdir(),'municipal-deadline-'));
  try {
    const start=Date.now();let requests=0;
    const out=await collectMunicipal({dataDir:dir,maxDurationMs:60,fetchImpl:async(_url,{signal})=>{
      requests++;
      return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('timeout')),{once:true}));
    }});
    assert.ok(Date.now()-start<1000); assert.ok(requests<=2); assert.equal(out.deadlineReached,true);
    assert.equal(out.complete,false); assert.ok(out.errors.length<=2);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
