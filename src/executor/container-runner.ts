import { READ_FILE_LIMITS, SEARCH_FILE_LIMITS } from './tool-limits.js';

export const CONTAINER_RUNNER = String.raw`
const readFileLimits = ${JSON.stringify(READ_FILE_LIMITS)};
const searchFileLimits = ${JSON.stringify(SEARCH_FILE_LIMITS)};
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const [mode, key, toolName, configuredFolder, configuredWorkspace] = process.argv.slice(1);
const folder = configuredFolder || '/tmp/pico-executions';
const workspace = configuredWorkspace || '/workspace';
const resultFile = path.join(folder, key + '.json');
const pidFile = path.join(folder, key + '.pid');
const childPidFile = path.join(folder, key + '.child.pid');
const send = value => process.stdout.write(JSON.stringify(value));
function readPid(file) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}
function processInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    if (!fs.existsSync('/proc/self/stat')) return { procAvailable: false };
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    return {
      procAvailable: true,
      state: fields[0],
      parentPid: Number(fields[1]),
      groupId: Number(fields[2]),
      startTime: fields[19],
    };
  } catch { return null; }
}

function runnerAlive() {
  const pid = readPid(pidFile);
  const info = processInfo(pid);
  if (!info) return false;
  if (!info.procAvailable) return true;
  try {
    return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').includes(key);
  } catch { return false; }
}

function readChildIdentity() {
  try {
    const raw = fs.readFileSync(childPidFile, 'utf8');
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object' && Number.isSafeInteger(value.pid) && value.pid > 0) {
        return { pid: value.pid, startTime: typeof value.startTime === 'string' ? value.startTime : null };
      }
    } catch {}
    const pid = Number(raw);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid, startTime: null } : null;
  } catch { return null; }
}

function childAlive(identity, runnerPid) {
  if (!identity) return false;
  const info = processInfo(identity.pid);
  if (!info) return false;
  if (!info.procAvailable) return true;
  if (info.groupId !== identity.pid) return false;
  if (identity.startTime) return info.startTime === identity.startTime;
  return Boolean(runnerPid && info.parentPid === runnerPid);
}

function alive() {
  const runnerPid = readPid(pidFile);
  return runnerAlive() || childAlive(readChildIdentity(), runnerPid);
}
function claim() {
  const temporary = pidFile + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
  fs.writeFileSync(temporary, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    // Keep this PID tombstone after exit so uncertain same-ID retries cannot repeat side effects.
    // Linking the fully written PID file gives concurrent submissions one atomic winner.
    fs.linkSync(temporary, pidFile);
    return true;
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}
async function readInput() {
  const chunks = [];
  for await (const part of process.stdin) chunks.push(part);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
async function search(root, pattern) {
  const regex = new RegExp(pattern);
  const matches = [];
  const ignored = new Set(['.git', 'node_modules', 'dist', 'target', '.next', '.pico']);
  let truncated = false;
  let outputCharacters = 0;
  let stop = false;
  function appendMatch(file, lineNumber, line) {
    const prefix = path.relative(root, file) + ':' + lineNumber + ':';
    const separatorCharacters = matches.length > 0 ? 1 : 0;
    const remaining = searchFileLimits.maxOutputCharacters - outputCharacters - separatorCharacters;
    if (remaining <= prefix.length) {
      truncated = true;
      stop = true;
      return;
    }
    const lineLimit = Math.min(searchFileLimits.maxLineCharacters, remaining - prefix.length);
    let excerpt = line;
    if (line.length > lineLimit) {
      const marker = '… [line truncated]';
      excerpt = lineLimit > marker.length ? line.slice(0, lineLimit - marker.length) + marker : line.slice(0, lineLimit);
      truncated = true;
    }
    const match = prefix + excerpt;
    matches.push(match);
    outputCharacters += separatorCharacters + match.length;
    if (matches.length >= searchFileLimits.maxMatches || outputCharacters >= searchFileLimits.maxOutputCharacters) {
      truncated = true;
      stop = true;
    }
  }
  async function walk(dir, depth) {
    if (stop) return;
    if (depth > searchFileLimits.maxDepth) {
      truncated = true;
      return;
    }
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (stop) return;
      if (ignored.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.isFile()) {
        const info = await fsp.stat(file);
        if (info.size > searchFileLimits.maxFileBytes) {
          truncated = true;
          continue;
        }
        const text = await fsp.readFile(file, 'utf8').catch(() => null);
        if (text === null || text.includes('\0')) continue;
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (stop) break;
          const line = lines[index];
          regex.lastIndex = 0;
          if (line !== undefined && regex.test(line)) appendMatch(file, index + 1, line);
        }
      }
    }
  }
  await walk(root, 0);
  return { matches, truncated };
}
function applyHunks(source, hunks) {
  const finalNewline = source.endsWith('\n');
  const lines = source === '' ? [] : source.replace(/\n$/, '').split('\n');
  const output = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const head = hunk.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (!head) throw new Error('Invalid patch hunk');
    const target = Number(head[1]) === 0 ? 0 : Number(head[1]) - 1;
    if (target < cursor || target > lines.length) throw new Error('Patch hunk is outside the file');
    output.push(...lines.slice(cursor, target));
    cursor = target;
    for (const item of hunk.split('\n').slice(1)) {
      if (item.startsWith('\\ No newline')) continue;
      const marker = item[0];
      const value = item.slice(1);
      if (marker === ' ') {
        if (lines[cursor] !== value) throw new Error('Patch context did not match: ' + value);
        output.push(lines[cursor++]);
      } else if (marker === '-') {
        if (lines[cursor] !== value) throw new Error('Patch removal did not match: ' + value);
        cursor++;
      } else if (marker === '+') output.push(value);
    }
  }
  output.push(...lines.slice(cursor));
  const result = output.join('\n');
  return result === '' ? '' : result + (finalNewline ? '\n' : '');
}
async function pathInside(value, allowMissing = false) {
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error('Tool paths must stay inside the selected workspace');
  const root = await fsp.realpath(workspace);
  const target = path.resolve(root, value || '.');
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Tool path is outside the workspace');
  const components = relative ? relative.split(path.sep) : [];
  let current = root;
  for (let index = 0; index < components.length; index++) {
    current = path.resolve(current, components[index]);
    try {
      const resolved = await fsp.realpath(current);
      const resolvedRelative = path.relative(root, resolved);
      if (resolvedRelative === '..' || resolvedRelative.startsWith('..' + path.sep) || path.isAbsolute(resolvedRelative)) {
        throw new Error('Tool path resolves outside the workspace');
      }
      current = resolved;
    } catch (error) {
      if (!allowMissing || error.code !== 'ENOENT') throw error;
      // A missing suffix is safe only after resolving every existing path component.
      // Reject entries that exist but cannot be realpathed, such as dangling symlinks.
      let exists = false;
      try {
        await fsp.lstat(current);
        exists = true;
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
      if (exists) throw new Error('Tool path resolves outside the workspace');
      return path.resolve(current, ...components.slice(index + 1));
    }
  }
  return current;
}
async function patch(patchText) {
  const text = patchText.replace(/^\*\*\* Begin Patch\n/, '').replace(/\n\*\*\* End Patch\s*$/, '\n');
  const blocks = text.split(/(?=^diff --git |^\*\*\* (?:Update|Add|Delete) File: )/m).filter(Boolean);
  const changed = [];
  for (const block of blocks) {
    const added = block.match(/^\*\*\* Add File: (.+)$/m)?.[1];
    const deleted = block.match(/^\*\*\* Delete File: (.+)$/m)?.[1];
    const updated = block.match(/^\*\*\* Update File: (.+)$/m)?.[1];
    const oldName = block.match(/^--- (?:a\/)?(.+)$/m)?.[1];
    const newName = block.match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1];
    const filename = added || deleted || updated || (newName && newName !== '/dev/null' ? newName : oldName);
    if (!filename || filename === '/dev/null') throw new Error('Patch needs a relative path');
    const target = await pathInside(filename, true);
    if (deleted || newName === '/dev/null') { await fsp.unlink(target); changed.push(filename); continue; }
    const hunks = block.split(/(?=^@@ )/m).filter(part => part.startsWith('@@ '));
    const before = added || oldName === '/dev/null' ? '' : await fsp.readFile(target, 'utf8');
    const additions = block.split('\n').filter(line => line.startsWith('+')).map(line => line.slice(1));
    const after = added && hunks.length === 0
      ? additions.join('\n') + (additions.length > 0 && block.endsWith('\n') ? '\n' : '')
      : applyHunks(before, hunks);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, after, 'utf8');
    changed.push(filename);
  }
  return changed;
}
async function readStoredResult() {
  return JSON.parse(await fsp.readFile(resultFile, 'utf8'));
}
async function writeResult(value) {
  await fsp.writeFile(resultFile + '.tmp', JSON.stringify(value));
  await fsp.rename(resultFile + '.tmp', resultFile);
  try { await fsp.unlink(childPidFile); } catch {}
}
async function run() {
  await fsp.mkdir(folder, { recursive: true });
  if (mode === 'status') {
    if (fs.existsSync(resultFile)) return send(await readStoredResult());
    return send({ status: alive() ? 'running' : 'interrupted' });
  }
  if (mode === 'interrupt') {
    if (fs.existsSync(resultFile)) return send(await readStoredResult());
    const runnerPid = readPid(pidFile);
    const hasRunner = runnerAlive();
    const childIdentity = readChildIdentity();
    const hasChild = childAlive(childIdentity, runnerPid);
    const targetPid = hasChild ? childIdentity.pid : hasRunner && !childIdentity ? runnerPid : null;
    if (targetPid) {
      try { process.kill(-targetPid, 'SIGTERM'); }
      catch { try { process.kill(targetPid, 'SIGTERM'); } catch {} }
    }
    if (fs.existsSync(resultFile)) return send(await readStoredResult());
    return send({ status: alive() ? 'running' : 'interrupted' });
  }
  if (mode !== 'run') throw new Error('Unsupported runner action');
  if (fs.existsSync(resultFile)) return send(await readStoredResult());
  if (!claim()) {
    if (fs.existsSync(resultFile)) return send(await readStoredResult());
    // A stale claim is an uncertain prior attempt, so the same execution key must not run again.
    return send({ status: alive() ? 'running' : 'interrupted' });
  }
  const toolChild = { pid: null };
  process.on('SIGTERM', () => {
    if (toolChild.pid) { try { process.kill(-toolChild.pid, 'SIGTERM'); } catch {} }
  });
  try {
    const args = await readInput();
    let result;
    if (toolName === 'read_file') {
      const file = await pathInside(args.path);
      const handle = await fsp.open(file, 'r');
      let size = 0;
      let bytesRead = 0;
      let buffer;
      try {
        size = (await handle.stat()).size;
        buffer = Buffer.alloc(Math.min(size, readFileLimits.maxBytes));
        while (bytesRead < buffer.length) {
          const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
          if (read.bytesRead === 0) break;
          bytesRead += read.bytesRead;
        }
      } finally {
        await handle.close();
      }
      const decoded = buffer.subarray(0, bytesRead).toString('utf8');
      if (decoded.includes('\0')) throw new Error('File contains binary data; read_file supports UTF-8 text files.');
      result = {
        path: path.relative(workspace, file),
        contents: decoded.slice(0, readFileLimits.maxCharacters),
        truncated: size > bytesRead || decoded.length > readFileLimits.maxCharacters,
      };
    } else if (toolName === 'search_files') result = await search(workspace, args.pattern);
    else if (toolName === 'apply_patch') result = { changed: await patch(args.patch) };
    else if (toolName === 'shell') {
      const command = spawn('/bin/sh', ['-lc', args.command], { cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      toolChild.pid = command.pid;
      const identity = processInfo(command.pid);
      fs.writeFileSync(childPidFile, JSON.stringify({ pid: command.pid, startTime: identity?.startTime ?? null }));
      let stdout = ''; let stderr = '';
      command.stdout.setEncoding('utf8').on('data', chunk => { stdout = (stdout + chunk).slice(-40000); });
      command.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-40000); });
      const timeout = setTimeout(() => { try { process.kill(-command.pid, 'SIGTERM'); } catch {} }, Math.min(Math.max(Number(args.timeout_ms) || 120000, 1000), 600000));
      const exit = await new Promise((resolve, reject) => {
        command.once('error', reject);
        command.once('close', (value, signal) => resolve({ code: value == null ? 1 : value, signal }));
      });
      clearTimeout(timeout);
      if (exit.signal) {
        const interrupted = { status: 'interrupted', error: 'Tool process received an explicit interrupt request.' };
        await writeResult(interrupted);
        return send(interrupted);
      }
      result = { exitCode: exit.code, stdout, stderr };
    } else throw new Error('Unknown executor tool: ' + toolName);
    const completed = { status: 'completed', result };
    await writeResult(completed);
    return send(completed);
  } catch (error) {
    const failed = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    await writeResult(failed);
    return send(failed);
  }
}
run().catch(error => { send({ status: 'failed', error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; });
`;
