'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { fail } = require('./errors.cjs');
const { utf8, durableWrite } = require('./vault-service.cjs');
const TEX_SOURCE_LIMIT = 2 * 1024 * 1024;
const PDF_LIMIT = 64 * 1024 * 1024;
const RUN_LIMIT = 128 * 1024 * 1024;
const BUNDLE_URL = 'https://relay.fullyjustified.net/default_bundle_v33.tar';

async function directoryBytes(directory, maximum, limit = 10000) {
  const queue = [directory]; let count = 0, total = 0;
  while (queue.length) {
    const current = queue.pop();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (++count > limit) throw Error('working-size-limit');
      const full = path.join(current, entry.name), stat = await fs.lstat(full);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw Error('working-file-type');
      if (stat.isDirectory()) queue.push(full); else total += stat.size;
      if (total > maximum) throw Error('working-size-limit');
    }
  }
  return total;
}
async function seedLatexCache(source, destination) {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(destination)).isSymbolicLink()) throw Error('cache-link');
  if (!source) return;
  const rootStat = await fs.lstat(source);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('invalid-cache-seed');
  await directoryBytes(source, 256 * 1024 * 1024);
  const queue = [{ source, destination }];
  while (queue.length) {
    const pair = queue.pop();
    for (const entry of await fs.readdir(pair.source, { withFileTypes: true })) {
      const from = path.join(pair.source, entry.name), to = path.join(pair.destination, entry.name);
      const sourceStat = await fs.lstat(from);
      if (sourceStat.isSymbolicLink()) throw Error('cache-link');
      let present;
      try { present = await fs.lstat(to); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (present?.isSymbolicLink() || (present && present.isDirectory() !== sourceStat.isDirectory())) throw Error('cache-link');
      if (sourceStat.isDirectory()) {
        if (!present) await fs.mkdir(to, { mode: 0o700 });
        queue.push({ source: from, destination: to });
      } else if (!present) {
        // Publish a complete cached file; a terminated first launch can retry missing files.
        const temp = to + '.seed-' + crypto.randomUUID();
        try { await fs.copyFile(from, temp, constants.COPYFILE_EXCL); await fs.link(temp, to); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        finally { await fs.unlink(temp).catch(() => {}); }
      }
    }
  }
}
function latexEnvironment(cacheDirectory, workingDirectory) {
  const env = { TECTONIC_CACHE_DIR: cacheDirectory, TECTONIC_UNTRUSTED_MODE: '1', LANG: 'C.UTF-8', TMPDIR: workingDirectory, TMP: workingDirectory, TEMP: workingDirectory };
  for (const name of ['SystemRoot', 'WINDIR']) if (process.env[name]) env[name] = process.env[name];
  return env;
}
class TexService {
  constructor({ vaultService, runtimePath, dataDirectory, seedCachePath, timeoutMs = 60000, maximumOutputBytes = 2 * 1024 * 1024, onlyCached = false }) {
    this.vaultService = vaultService; this.runtimePath = runtimePath; this.dataDirectory = dataDirectory; this.seedCachePath = seedCachePath;
    this.timeoutMs = timeoutMs; this.maximumOutputBytes = maximumOutputBytes; this.onlyCached = onlyCached;
    this.active = null; this.closed = false; this.cacheReady = null;
  }
  async info() {
    try { const stat = await fs.lstat(this.runtimePath); return { available: stat.isFile() && !stat.isSymbolicLink() }; }
    catch { return { available: false }; }
  }
  async prepareCache() {
    const destination = path.join(this.dataDirectory, 'latex-cache');
    if (!this.cacheReady) this.cacheReady = seedLatexCache(this.seedCachePath, destination).catch(error => { this.cacheReady = null; throw error; });
    await this.cacheReady; return destination;
  }
  stop(run, reason) {
    if (run.reason) return;
    run.reason = reason;
    if (run.finished) return;
    const child = run.child;
    if (!child?.pid) return;
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot || process.env.WINDIR;
      if (systemRoot) {
        const killer = spawn(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill();
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      run.killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 1000);
      run.killTimer.unref?.();
    }
  }
  async compile(request) {
    if (this.closed) fail('CANCELLED');
    if (this.active) fail('BUSY');
    if (typeof request?.path !== 'string' || !/\.tex$/i.test(request.path) || !/^[a-f0-9]{64}$/i.test(request.expectedSHA256 || '')) fail('INVALID_REQUEST');
    const run = { child: null, finished: false, reason: null, killTimer: null, timer: null, monitor: null, bytes: 0, chunks: [] };
    this.active = run; let workingDirectory;
    const append = text => { const data = Buffer.from(text); const count = Math.min(data.length, Math.max(0, this.maximumOutputBytes - run.bytes)); if (count) { run.chunks.push(data.subarray(0, count)); run.bytes += count; } };
    try {
      if (!(await this.info()).available) return { path: null, log: 'The bundled Tectonic runtime is unavailable on this platform. The source file was not changed.' };
      const snapshot = await this.vaultService.snapshot(request, TEX_SOURCE_LIMIT);
      if (snapshot.sha256 !== request.expectedSHA256.toLowerCase()) fail('CONFLICT');
      utf8(snapshot.data);
      const cache = await this.prepareCache();
      if (run.reason || this.closed) fail('CANCELLED');
      const runRoot = path.join(this.dataDirectory, 'latex-runs'); await fs.mkdir(runRoot, { recursive: true, mode: 0o700 });
      workingDirectory = await fs.mkdtemp(path.join(runRoot, 'compile-'));
      const outputDirectory = path.join(workingDirectory, 'output'); await fs.mkdir(outputDirectory, { mode: 0o700 });
      const input = path.join(workingDirectory, 'source.tex'); await durableWrite(input, snapshot.data);
      const args = ['--untrusted', '--color', 'never', '--bundle', BUNDLE_URL, '--outdir', outputDirectory, '--print'];
      if (this.onlyCached) args.push('--only-cached'); args.push(input);
      append(`Tectonic 0.17.0 — source snapshot SHA256 ${snapshot.sha256}\nSingle-file compile. Adjacent project files are not copied. Missing TeX packages may require an internet connection.\n\n`);
      const child = spawn(this.runtimePath, args, { cwd: workingDirectory, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: latexEnvironment(cache, workingDirectory) });
      run.child = child;
      const decoder = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
      const forward = (kind, data) => {
        const available = Math.max(0, this.maximumOutputBytes - run.bytes), part = data.subarray(0, available);
        append(decoder[kind].write(part));
        if (data.length > available) this.stop(run, 'log_limit');
      };
      child.stdout.on('data', data => forward('stdout', data)); child.stderr.on('data', data => forward('stderr', data));
      run.timer = setTimeout(() => this.stop(run, 'timeout'), this.timeoutMs); run.timer.unref?.();
      let checking = false;
      run.monitor = setInterval(() => { if (checking || run.finished) return; checking = true; void directoryBytes(workingDirectory, RUN_LIMIT).catch(() => this.stop(run, 'output_limit')).finally(() => { checking = false; }); }, 250); run.monitor.unref?.();
      const exit = await new Promise(resolve => { child.once('error', () => { run.reason = 'runtime_error'; resolve(null); }); child.once('close', code => resolve(code)); });
      run.finished = true; clearTimeout(run.timer); clearTimeout(run.killTimer); clearInterval(run.monitor);
      append(decoder.stdout.end()); append(decoder.stderr.end());
      const finishLog = message => (Buffer.concat(run.chunks).toString('utf8') + '\n' + message).slice(0, this.maximumOutputBytes + 1000);
      if (run.reason || exit !== 0 || this.closed) {
        const reasons = { timeout: 'Compilation reached the time limit.', log_limit: 'Compiler output reached the log limit.', output_limit: 'Generated working files reached the size limit.', cancelled: 'Compilation was stopped.', runtime_error: 'The compiler could not be started.' };
        return { path: null, log: finishLog((reasons[run.reason] || 'LaTeX compilation failed. Check the error above; if packages are missing, connect to the internet and retry.') + ' The source and existing PDFs were not changed.') };
      }
      const pdfPath = path.join(outputDirectory, 'source.pdf');
      const stat = await fs.lstat(pdfPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 5 || stat.size > PDF_LIMIT) return { path: null, log: finishLog('The generated PDF is missing or exceeds 64 MiB. The source and existing PDFs were not changed.') };
      const handle = await fs.open(pdfPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); let data;
      try { data = await handle.readFile(); } finally { await handle.close(); }
      if (data.length !== stat.size || data.length > PDF_LIMIT || data.subarray(0, 5).toString('ascii') !== '%PDF-') return { path: null, log: finishLog('The compiler did not produce a valid PDF header. Existing files were not changed.') };
      if (run.reason || this.closed) return { path: null, log: finishLog('Compilation was stopped before publication. Existing files were not changed.') };
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      const base = Array.from(path.posix.basename(request.path).replace(/\.tex$/i, '')).slice(0, 100).join('') || 'document';
      const name = `${base}.compiled-${stamp}-${crypto.randomUUID().slice(0, 8)}.pdf`;
      const created = await this.vaultService.createData(request.vaultId, path.posix.dirname(request.path) === '.' ? '' : path.posix.dirname(request.path), name, data);
      return { path: created.path, log: finishLog('PDF saved as a new file from the confirmed source snapshot. The original .tex and existing PDFs were not changed.') };
    } catch (error) {
      if (['INVALID_REQUEST', 'CONFLICT', 'PATH_DENIED', 'INVALID_TEXT', 'TOO_LARGE', 'BUSY', 'CANCELLED', 'NO_VAULT'].includes(error.code)) throw error;
      return { path: null, log: Buffer.concat(run.chunks).toString('utf8') + '\nCompilation or publication could not complete. Check storage, runtime resources and connection, then retry. The source and existing PDFs were not changed.' };
    } finally {
      clearTimeout(run.timer); clearInterval(run.monitor); clearTimeout(run.killTimer);
      if (!run.finished && run.child) this.stop(run, 'cancelled');
      if (this.active === run) this.active = null;
      if (workingDirectory) await fs.rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
  cancel() { if (this.active) this.stop(this.active, 'cancelled'); }
  dispose() { this.closed = true; this.cancel(); }
}
module.exports = { TexService, seedLatexCache, latexEnvironment, TEX_SOURCE_LIMIT, PDF_LIMIT, BUNDLE_URL };
