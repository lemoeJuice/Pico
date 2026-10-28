import { readFileSync } from 'node:fs';
import path from 'node:path';

function readLock(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { error: `${label} lock is missing or invalid.` };
  }
  if (!parsed || !Number.isInteger(parsed.lockfileVersion) || !parsed.packages || typeof parsed.packages !== 'object') {
    return { error: `${label} lock has an unsupported structure.` };
  }
  return { lock: parsed };
}

/**
 * Compare the installed package inventory with the snapshot lock without invoking npm,
 * reading npm configuration, or consulting registry credentials.
 */
export function compareInstalledLock(snapshotRoot, workspaceRoot) {
  const expectedPath = path.join(snapshotRoot, 'package-lock.json');
  const installedPath = path.join(workspaceRoot, 'node_modules', '.package-lock.json');
  const expectedResult = readLock(expectedPath, 'Snapshot package');
  if (expectedResult.error) return { matches: false, reason: expectedResult.error };
  const installedResult = readLock(installedPath, 'Installed package');
  if (installedResult.error) return { matches: false, reason: installedResult.error };

  const expected = expectedResult.lock.packages;
  const installed = installedResult.lock.packages;
  const expectedPackages = Object.fromEntries(Object.entries(expected).filter(([name]) => name !== ''));
  const installedPackages = Object.fromEntries(Object.entries(installed).filter(([name]) => name !== ''));

  for (const name of Object.keys(installedPackages).sort()) {
    if (!Object.hasOwn(expectedPackages, name)) {
      return { matches: false, reason: `Installed package inventory has an extra entry: ${name}.` };
    }
  }

  for (const [name, expectedEntry] of Object.entries(expectedPackages).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const installedEntry = installedPackages[name];
    if (!installedEntry) {
      if (expectedEntry?.optional === true) continue;
      return { matches: false, reason: `Installed package inventory is missing required entry: ${name}.` };
    }
    if (!expectedEntry || typeof expectedEntry !== 'object' || typeof installedEntry !== 'object') {
      return { matches: false, reason: `Package lock entry is invalid: ${name}.` };
    }
    if (expectedEntry.version !== installedEntry.version) {
      return { matches: false, reason: `Installed package version differs from snapshot lock: ${name}.` };
    }
    if ((expectedEntry.integrity ?? null) !== (installedEntry.integrity ?? null)) {
      return { matches: false, reason: `Installed package integrity differs from snapshot lock: ${name}.` };
    }
  }

  return { matches: true, reason: 'Installed package versions and integrity match the snapshot lock.' };
}
