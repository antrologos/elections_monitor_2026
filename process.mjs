import { spawn } from 'node:child_process';

export function safeError(error) {
  return String(error?.message || error).replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[redacted]@')
    .replace(/(authorization[:=]\s*)([^\r\n]+)/ig, '$1[redacted]').slice(-16000);
}

// A timeout kills the whole process group, including grandchildren holding pipes open.
export function runCommand(command, args, { cwd, timeoutMs = 15000, signal, onEvent = () => {}, env = process.env } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(Error('Invalid command timeout'));
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd, env: {...env, GIT_TERMINAL_PROMPT:'0'},
      detached: process.platform !== 'win32', stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', reason = null, grace, spawnError;
    const append = (old, chunk) => (old + chunk.toString()).slice(-65536);
    child.stdout.on('data', x => {stdout = append(stdout,x);});
    child.stderr.on('data', x => {stderr = append(stderr,x);});
    const kill = sig => {
      if (!child.pid) return;
      try { process.platform === 'win32' ? child.kill(sig) : process.kill(-child.pid,sig); }
      catch (e) { if (e.code !== 'ESRCH') stderr = append(stderr,e.message); }
    };
    const stop = why => { if(reason) return; reason=why; kill('SIGTERM'); grace=setTimeout(()=>kill('SIGKILL'),500); };
    const abort = () => stop('aborted');
    const timer = setTimeout(()=>stop('timeout'),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted) abort();
    onEvent({event:'command_started',command,operation:args[0],pid:child.pid});
    child.on('error',e=>{spawnError=e;});
    child.on('close',(code,sig)=>{
      clearTimeout(timer);clearTimeout(grace);signal?.removeEventListener('abort',abort);
      // Kill any descendants still alive even if the group leader exited early.
      if(reason) kill('SIGKILL');
      const result={command,operation:args[0],code,signal:sig,reason,elapsedMs:performance.now()-started,stdout,stderr};
      onEvent({event:'command_finished',...result,stdout:undefined,stderr:safeError(stderr)});
      if(reason||spawnError||code!==0) {
        const error=new Error(`${command} ${args[0]}: ${reason||spawnError?.code||`exit ${code}`}\n${safeError(stderr||spawnError||'')}`);
        Object.assign(error,{result});reject(error);
      } else resolve(result);
    });
  });
}
