import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// A running Node process does not reveal the exact bytes it loaded. Record the
// installed files alongside its identity and reject later out-of-band builds.
export function runtimeArtifactHashes(projectRoot) {
  const result = {};
  function add(relativePath) {
    const absolutePath = path.join(projectRoot, relativePath);
    const entry = lstatSync(absolutePath);
    if (entry.isSymbolicLink()) throw new Error(`Runtime artifact is a symbolic link: ${relativePath}`);
    if (entry.isDirectory()) {
      for (const name of readdirSync(absolutePath).sort()) add(path.join(relativePath, name));
    } else if (entry.isFile()) {
      result[relativePath.split(path.sep).join('/')] = createHash('sha256')
        .update(readFileSync(absolutePath))
        .digest('hex');
    } else {
      throw new Error(`Unsupported Runtime artifact: ${relativePath}`);
    }
  }

  add('dist/server');
  add('dist/executor-agent.mjs');
  for (const entry of readdirSync(path.join(projectRoot, 'plugins'), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) add(path.join('plugins', entry.name));
    if (entry.isDirectory() && existsSync(path.join(projectRoot, 'plugins', entry.name, 'runtime.mjs'))) {
      add(path.join('plugins', entry.name, 'runtime.mjs'));
    }
  }
  if (!result['dist/server/server.js'] || !result['dist/executor-agent.mjs']) {
    throw new Error('The Runtime build is missing required artifacts.');
  }
  return result;
}
