import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { classifyPath, releaseTargets } from './rules.mjs';

const MANIFEST_VERSION = 1;
const SOURCE_ROOTS = ['src', 'plugins', 'public', 'scripts', 'test', 'config', 'migrations'];
const SOURCE_FILES = [
  'index.html',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'vite.config.ts',
  'eslint.config.js',
];
const NEVER_SCAN = new Set([
  '.git',
  '.codex',
  '.agents',
  '.aws',
  '.env',
  '.env.*',
  'node_modules',
  'dist',
  'data',
  'coverage',
  '.cache',
  '.vite',
  '.turbo',
]);

function shouldSkipDirectory(name) {
  return NEVER_SCAN.has(name) || name.startsWith('.');
}

function walkSourceFiles(rootDir, directory, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name)) walkSourceFiles(rootDir, path.join(directory, entry.name), found);
      continue;
    }
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const absolutePath = path.join(directory, entry.name);
    found.add(path.relative(rootDir, absolutePath).split(path.sep).join('/'));
  }
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Hash only the release source roots and known build inputs. This includes tracked and
 * untracked source files while avoiding secrets, local data, Git metadata, and outputs.
 */
export function buildReleaseManifest(rootDir) {
  const absoluteRoot = path.resolve(rootDir);
  const candidates = new Set();
  for (const relativeRoot of SOURCE_ROOTS) {
    const absolutePath = path.join(absoluteRoot, relativeRoot);
    if (existsSync(absolutePath) && lstatSync(absolutePath).isDirectory()) {
      walkSourceFiles(absoluteRoot, absolutePath, candidates);
    }
  }
  for (const relativePath of SOURCE_FILES) {
    const absolutePath = path.join(absoluteRoot, relativePath);
    if (existsSync(absolutePath) && lstatSync(absolutePath).isFile()) candidates.add(relativePath);
  }
  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.startsWith('.')) candidates.add(entry.name);
    if (
      entry.isDirectory() &&
      !shouldSkipDirectory(entry.name) &&
      !SOURCE_ROOTS.includes(entry.name) &&
      !['docs', 'design-docs'].includes(entry.name)
    ) {
      walkSourceFiles(absoluteRoot, path.join(absoluteRoot, entry.name), candidates);
    }
  }

  const targets = Object.fromEntries(releaseTargets().map((target) => [target, { files: {}, actions: {} }]));
  const checks = { files: {}, actions: {} };
  const ignoredPaths = [];
  const unknownPaths = [];
  for (const relativePath of [...candidates].sort()) {
    const disposition = classifyPath(relativePath);
    if (disposition.kind === 'ignore') {
      ignoredPaths.push({ path: relativePath, reason: disposition.reason });
      continue;
    }
    if (disposition.kind === 'block') {
      unknownPaths.push({ path: relativePath, reason: disposition.reason });
      continue;
    }
    const digest = sha256(path.join(absoluteRoot, relativePath));
    if (disposition.kind === 'check') {
      checks.files[relativePath] = digest;
      checks.actions[relativePath] = { action: disposition.action, reason: disposition.reason };
      continue;
    }
    for (const target of disposition.targets) {
      targets[target] ??= { files: {}, actions: {} };
      targets[target].files[relativePath] = digest;
      targets[target].actions[relativePath] = {
        action: disposition.action,
        reason: disposition.reason,
      };
    }
  }
  return { version: MANIFEST_VERSION, targets, checks, ignoredPaths, unknownPaths };
}

/** Read a persisted baseline. Invalid or unsupported baselines fail closed as absent. */
export function readReleaseBaseline(filePath) {
  try {
    const baseline = JSON.parse(readFileSync(filePath, 'utf8'));
    if (baseline?.version !== MANIFEST_VERSION || !baseline.targets || typeof baseline.targets !== 'object')
      return null;
    if (!baseline.checks?.files || typeof baseline.checks.files !== 'object') return null;
    if (releaseTargets().some((target) => !baseline.targets[target])) return null;
    for (const target of Object.values(baseline.targets)) {
      if (!target || !target.files || typeof target.files !== 'object') return null;
      if (Object.values(target.files).some((digest) => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) {
        return null;
      }
    }
    if (
      Object.values(baseline.checks.files).some(
        (digest) => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest),
      )
    ) {
      return null;
    }
    return baseline;
  } catch {
    return null;
  }
}

/** Persist a current manifest atomically enough for a small local baseline file. */
export function writeReleaseBaseline(filePath, manifest) {
  if (
    manifest?.version !== MANIFEST_VERSION ||
    !manifest.targets ||
    typeof manifest.targets !== 'object' ||
    !manifest.checks?.files
  ) {
    throw new TypeError('Cannot persist an invalid release manifest.');
  }
  if (releaseTargets().some((target) => !manifest.targets[target])) {
    throw new TypeError('Cannot persist a manifest that lacks a release target.');
  }
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      /* Preserve the original write error. */
    }
    throw error;
  }
}

function filesFor(targetManifest) {
  return targetManifest?.files ?? {};
}

function isStructurallyValidManifest(manifest) {
  if (
    manifest?.version !== MANIFEST_VERSION ||
    !manifest.targets ||
    typeof manifest.targets !== 'object' ||
    !manifest.checks?.files
  )
    return false;
  if (releaseTargets().some((target) => !manifest.targets[target])) return false;
  return (
    Object.values(manifest.targets).every(
      (target) =>
        target &&
        target.files &&
        typeof target.files === 'object' &&
        Object.values(target.files).every((digest) => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)),
    ) &&
    Object.values(manifest.checks.files).every((digest) => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest))
  );
}

/** Compare inventories and report differences without suggesting an execution scope. */
export function diagnoseChanges({ currentManifest, baselineManifest }) {
  const unknownPaths = currentManifest?.unknownPaths ?? [];
  if (!isStructurallyValidManifest(currentManifest) || !isStructurallyValidManifest(baselineManifest)) {
    return { targets: [], changedChecks: [], unknownPaths };
  }

  const targets = [];
  const names = new Set([...Object.keys(currentManifest.targets), ...Object.keys(baselineManifest.targets)]);
  for (const target of [...names].sort()) {
    const currentFiles = filesFor(currentManifest.targets[target]);
    const baselineFiles = filesFor(baselineManifest.targets[target]);
    const paths = [...new Set([...Object.keys(currentFiles), ...Object.keys(baselineFiles)])]
      .filter((relativePath) => currentFiles[relativePath] !== baselineFiles[relativePath])
      .sort();
    if (paths.length) targets.push({ target, paths });
  }

  return { targets, changedChecks: compareChecks(currentManifest, baselineManifest), unknownPaths };
}

function compareChecks(currentManifest, baselineManifest) {
  if (!currentManifest?.checks?.files) return [];
  const currentFiles = currentManifest.checks.files;
  const baselineFiles = baselineManifest?.checks?.files ?? {};
  return [...new Set([...Object.keys(currentFiles), ...Object.keys(baselineFiles)])]
    .filter((relativePath) => currentFiles[relativePath] !== baselineFiles[relativePath])
    .sort()
    .map((relativePath) => ({
      path: relativePath,
      action:
        currentManifest.checks.actions?.[relativePath]?.action ??
        baselineManifest?.checks?.actions?.[relativePath]?.action ??
        classifyPath(relativePath).action ??
        'run-tests',
    }));
}
