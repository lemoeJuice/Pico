import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const validId = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

async function copyTree(source, target) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Refusing symlink in web snapshot: ${source}`);
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const name of await readdir(source)) await copyTree(join(source, name), join(target, name));
  } else if (info.isFile()) {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  } else {
    throw new Error(`Unsupported web snapshot entry: ${source}`);
  }
}

function rewriteHtml(html, rewrite) {
  return html.replace(
    /(\b(?:src|href)\s*=\s*)(["'])([^"']+)\2/gi,
    (_match, prefix, quote, url) => `${prefix}${quote}${rewrite(url)}${quote}`,
  );
}

async function hashFile(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function contentType(path) {
  const ext = path.split('.').at(-1)?.toLowerCase();
  return (
    {
      css: 'text/css',
      html: 'text/html',
      js: 'text/javascript',
      mjs: 'text/javascript',
      json: 'application/json',
      svg: 'image/svg+xml',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      avif: 'image/avif',
      gif: 'image/gif',
      woff: 'font/woff',
      woff2: 'font/woff2',
      ico: 'image/x-icon',
      wasm: 'application/wasm',
    }[ext] ?? 'application/octet-stream'
  );
}

function safeThemeAssetPath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || /[\\%\0?#:]/.test(value)) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..');
}

function isThemeImage(path) {
  return ['.avif', '.gif', '.jpg', '.jpeg', '.png', '.svg', '.webp'].includes(
    path.slice(path.lastIndexOf('.')).toLowerCase(),
  );
}

async function readThemeAssets(manifestPath) {
  if (!existsSync(manifestPath)) return [];
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error(`Invalid plugin theme asset manifest: ${manifestPath}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !Array.isArray(manifest.assets)) {
    throw new Error(`Invalid plugin theme asset manifest: ${manifestPath}`);
  }
  if (!manifest.assets.every((path) => safeThemeAssetPath(path))) {
    throw new Error(`Unsafe path in plugin theme asset manifest: ${manifestPath}`);
  }
  if (new Set(manifest.assets).size !== manifest.assets.length) {
    throw new Error(`Duplicate path in plugin theme asset manifest: ${manifestPath}`);
  }
  for (const path of manifest.assets) {
    if (!isThemeImage(path)) throw new Error(`Plugin theme asset must be an image: ${path}`);
  }
  return manifest.assets;
}

function localEntryReferences(html) {
  return [...html.matchAll(/\b(?:src|href)\s*=\s*(["'])([^"']+)\1/gi)]
    .map((match) => match[2])
    .filter((url) => !/^(?:[a-z]+:|#|data:|\/\/)/i.test(url));
}

async function addAsset({ url, file, urls, hashes, assets }) {
  if (!existsSync(file)) throw new Error(`Web release entry references missing resource: ${url}`);
  const sha256 = await hashFile(file);
  urls.push(url);
  hashes[url] = sha256;
  assets.push({ url, sha256, contentType: contentType(file) });
}

function releaseFile(root, path) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, path);
  const fromRoot = relative(resolvedRoot, resolvedPath);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || fromRoot.startsWith(sep)) {
    throw new Error(`Web release entry escapes its version directory: ${path}`);
  }
  return resolvedPath;
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, content);
  await rename(temp, path);
}

/**
 * Prepare immutable versioned resources and return an entrypoint transaction.
 * Call commit only after the runtime restart is ready; rollback restores every
 * entrypoint changed by a partially completed commit.
 */
export async function prepareWebPublication({ sourceRoot, targetRoot, releaseId, scope, sharedReleaseId }) {
  if (!validId.test(releaseId)) throw new Error('releaseId must be a safe path segment');
  const source = resolve(sourceRoot);
  const target = resolve(targetRoot);
  const main = Boolean(scope?.mainWeb);
  const pluginIds = [...new Set(scope?.pluginIds ?? [])];
  if (pluginIds.some((id) => !validId.test(id))) throw new Error('plugin ids must be safe path segments');
  if ((main || pluginIds.length) && !validId.test(sharedReleaseId ?? releaseId))
    throw new Error('sharedReleaseId must be a safe path segment');
  const sharedId = sharedReleaseId ?? releaseId;
  const prepared = [];
  const entries = [];
  const urls = [];
  const hashes = {};
  const assets = [];
  const targets = [];

  try {
    if (main) {
      const clientSource = join(source, 'dist', 'client');
      const indexSource = join(clientSource, 'index.html');
      if (!existsSync(indexSource)) throw new Error('Web snapshot is missing dist/client/index.html');
      const clientTarget = join(target, 'dist', 'client');
      const releaseTarget = join(clientTarget, 'releases', releaseId);
      if (existsSync(releaseTarget)) throw new Error(`Web release already exists: ${releaseId}`);
      prepared.push(releaseTarget);
      await copyTree(clientSource, releaseTarget);
      const rewritten = rewriteHtml(await readFile(indexSource, 'utf8'), (url) => {
        if (url.startsWith('/assets/')) return `/releases/${releaseId}${url}`;
        if (url.startsWith('/')) return `/releases/${releaseId}${url}`;
        return url;
      });
      const entry = join(clientTarget, 'index.html');
      entries.push({ path: entry, content: rewritten });
      urls.push('/');
      hashes['/'] = createHash('sha256').update(rewritten).digest('hex');
      assets.push({ url: '/', sha256: hashes['/'], contentType: 'text/html' });
      for (const rawUrl of localEntryReferences(rewritten)) {
        if (!rawUrl.startsWith(`/releases/${releaseId}/`))
          throw new Error(`Main WebUI entry has an unversioned local resource: ${rawUrl}`);
        const relativePath = decodeURIComponent(rawUrl.slice(`/releases/${releaseId}/`.length).split(/[?#]/, 1)[0]);
        await addAsset({ url: rawUrl, file: releaseFile(releaseTarget, relativePath), urls, hashes, assets });
      }
      if (!assets.some((asset) => asset.url !== '/'))
        throw new Error('Web index contains no versioned resource references');
    }

    for (const pluginId of pluginIds) {
      const webuiSource = join(source, 'plugins', pluginId, 'webui');
      const indexSource = join(webuiSource, 'index.html');
      if (!existsSync(indexSource)) throw new Error(`Plugin snapshot is missing ${pluginId}/webui/index.html`);
      const webuiTarget = join(target, 'dist', 'plugin-ui', pluginId, 'webui');
      const releaseTarget = join(webuiTarget, 'releases', releaseId);
      if (existsSync(releaseTarget)) throw new Error(`Plugin UI release already exists: ${pluginId}/${releaseId}`);
      prepared.push(releaseTarget);
      await copyTree(webuiSource, releaseTarget);
      const rewritten = rewriteHtml(await readFile(indexSource, 'utf8'), (url) => {
        if (url === '/pico-plugin-ui-bridge.js' || url === '/pico-plugin-ui.css') return `/releases/${sharedId}${url}`;
        return url;
      });
      const versionEntry = join(releaseTarget, 'index.html');
      await atomicWrite(versionEntry, rewritten);
      const entry = join(webuiTarget, 'index.html');
      const stableEntry = rewriteHtml(rewritten, (url) => {
        if (url.startsWith('/') || /^(?:[a-z]+:|#)/i.test(url)) return url;
        return `/_pico/plugin-ui/${pluginId}/webui/releases/${releaseId}/${url.replace(/^\.\//, '')}`;
      });
      const stableEntryWithRelease = `<!-- pico-plugin-ui-release:${releaseId} -->\n${stableEntry}`;
      entries.push({ path: entry, content: stableEntryWithRelease });
      const pluginIndexUrl = `/_pico/plugin-ui/${pluginId}/webui/releases/${releaseId}/index.html`;
      await addAsset({ url: pluginIndexUrl, file: versionEntry, urls, hashes, assets });
      for (const rawUrl of localEntryReferences(rewritten)) {
        if (rawUrl.startsWith(`/releases/${sharedId}/`)) {
          const relativePath = decodeURIComponent(rawUrl.slice(`/releases/${sharedId}/`.length).split(/[?#]/, 1)[0]);
          await addAsset({
            url: rawUrl,
            file: join(target, 'dist', 'client', 'releases', sharedId, relativePath),
            urls,
            hashes,
            assets,
          });
        } else if (rawUrl.startsWith('./') || !rawUrl.startsWith('/')) {
          const relativePath = decodeURIComponent(rawUrl.replace(/^\.\//, '').split(/[?#]/, 1)[0]);
          await addAsset({
            url: `/_pico/plugin-ui/${pluginId}/webui/releases/${releaseId}/${relativePath}`,
            file: releaseFile(releaseTarget, relativePath),
            urls,
            hashes,
            assets,
          });
        } else if (rawUrl.startsWith(`/_pico/plugin-ui/${pluginId}/webui/releases/${releaseId}/`)) {
          const relativePath = decodeURIComponent(rawUrl.split(`/releases/${releaseId}/`)[1].split(/[?#]/, 1)[0]);
          await addAsset({ url: rawUrl, file: releaseFile(releaseTarget, relativePath), urls, hashes, assets });
        } else {
          throw new Error(`Plugin UI entry has an unversioned local resource: ${rawUrl}`);
        }
      }
      const themeAssets = await readThemeAssets(join(webuiSource, 'theme-assets.json'));
      for (const assetPath of themeAssets) {
        const assetFile = releaseFile(releaseTarget, assetPath);
        if (!existsSync(assetFile)) throw new Error(`Plugin theme asset is missing: ${assetPath}`);
        const info = await lstat(assetFile);
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error(`Plugin theme asset is not a regular file: ${assetPath}`);
        await addAsset({
          url: `/_pico/plugin-ui/${pluginId}/webui/releases/${releaseId}/${assetPath}`,
          file: assetFile,
          urls,
          hashes,
          assets,
        });
      }
      if (themeAssets.length) {
        await addAsset({
          url: `/_pico/plugin-ui/${pluginId}/webui/releases/${releaseId}/theme-assets.json`,
          file: join(releaseTarget, 'theme-assets.json'),
          urls,
          hashes,
          assets,
        });
      }
      urls.push(`/_pico/plugin-ui/${pluginId}/webui/index.html`);
      hashes[`/_pico/plugin-ui/${pluginId}/webui/index.html`] = createHash('sha256')
        .update(stableEntryWithRelease)
        .digest('hex');
      assets.push({
        url: `/_pico/plugin-ui/${pluginId}/webui/index.html`,
        sha256: hashes[`/_pico/plugin-ui/${pluginId}/webui/index.html`],
        contentType: 'text/html',
      });
      targets.push(pluginId);
    }

    let committed = false;
    let previous = [];
    return {
      releaseId,
      sharedReleaseId: sharedId,
      urls: [...new Set(urls)],
      hashes,
      assets,
      pluginIds: targets,
      async commit() {
        if (committed) return;
        previous = [];
        try {
          for (const entry of entries) {
            const old = existsSync(entry.path) ? await readFile(entry.path) : null;
            previous.push({ path: entry.path, old });
            await atomicWrite(entry.path, entry.content);
          }
          committed = true;
        } catch (error) {
          await this.rollback();
          throw error;
        }
      },
      async rollback() {
        for (const item of [...previous].reverse()) {
          if (item.old === null) await rm(item.path, { force: true });
          else await atomicWrite(item.path, item.old);
        }
        previous = [];
        committed = false;
      },
      async cleanupPrepared() {
        if (committed) throw new Error('Cannot clean a committed publication');
        for (const path of prepared) await rm(path, { recursive: true, force: true });
      },
    };
  } catch (error) {
    for (const path of prepared) await rm(path, { recursive: true, force: true });
    throw error;
  }
}
