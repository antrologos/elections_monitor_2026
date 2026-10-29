import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCommand} from './process.mjs';
import {main} from './collector.mjs';

test('command error retains exit code and useful stderr while redacting credentials',async()=>{
  const events=[];
  await assert.rejects(runCommand(process.execPath,['-e','console.error("rejected: non-fast-forward https://user:secret@example.com/repo");process.exit(7)'],{onEvent:e=>events.push(e)}),e=>{
    assert.equal(e.result.code,7);assert.match(e.message,/non-fast-forward/);assert.doesNotMatch(e.message,/secret/);return true;
  });
  assert.doesNotMatch(JSON.stringify(events),/secret/);
});

test('timeout kills a child ignoring TERM and its descendant',async()=>{
  let pid;
  const script=`const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});console.log(c.pid);setInterval(()=>{},1000)`;
  const start=performance.now();
  await assert.rejects(runCommand(process.execPath,['-e',script],{timeoutMs:250}),e=>{
    assert.equal(e.result.reason,'timeout');pid=Number(e.result.stdout.trim());return true;
  });
  assert.ok(performance.now()-start<3000);
  if(pid){
    try{const stat=await readFile(`/proc/${pid}/stat`,'utf8');assert.equal(stat.split(') ')[1][0],'Z','descendant must not still execute');}
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
});

test('abort cancels a command independently of its normal timeout',async()=>{
  const controller=new AbortController();
  const pending=runCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal,timeoutMs:2000});
  controller.abort();
  await assert.rejects(pending,e=>e.result.reason==='aborted');
});

test('invalid CLI options fail before any collector starts',async()=>{
  for(const args of [['--data-dir'],['--wall-timeout-seconds','999'],['--duration-minutes','330'],['--once','--once']])
    await assert.rejects(main(args));
});

const success={lastAttemptAt:'2026-10-28T00:00:00Z',checkedAt:'2026-10-28T00:00:00Z',
  successfulSources:30,expectedSources:30,completion:{completed:false},municipal:{errors:[]}};

test('publication failure records the exact failing phase and all three attempts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'collector-failure-'));let attempts=0;
  try{
    await assert.rejects(main(['--data-dir',dir,'--once','--publish'],{
      collectImpl:async()=>success,publishImpl:async()=>{attempts++;throw Error('git rejected: non-fast-forward');}
    }),/non-fast-forward/);
    const status=JSON.parse(await readFile(join(dir,'.runtime/status.json'),'utf8'));
    assert.equal(attempts,3);assert.equal(status.state,'failed');assert.equal(status.failedPhase,'publishing');
    assert.match(status.lastError,/non-fast-forward/);
    const events=(await readFile(join(dir,'.runtime/events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(e=>e.event==='publish_failed').length,3);
    assert.equal(events.at(-1).event,'run_finished');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('wall timeout records timed_out and terminal state, with no success marker',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'collector-timeout-'));
  try{
    await assert.rejects(main(['--data-dir',dir,'--wall-timeout-seconds','0.05'],{
      collectImpl:async({signal,onProgress})=>{onProgress('sources');await new Promise((resolve,reject)=>{
        if(signal.aborted)return reject(signal.reason);
        signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
      });}
    }));
    const status=JSON.parse(await readFile(join(dir,'.runtime/status.json'),'utf8'));
    assert.equal(status.state,'timed_out');assert.equal(status.failedPhase,'sources');assert.equal(status.cycles,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
