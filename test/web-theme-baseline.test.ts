import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? cssFiles(path) : entry.name.endsWith('.css') ? [path] : [];
  });
}

describe('WebUI light appearance baseline', () => {
  it('loads definitions for every required framework appearance variable', () => {
    const entry = readFileSync(resolve(root, 'src/web/styles.css'), 'utf8');
    const themeImports = [...entry.matchAll(/@import '\.\/styles\/themes\/([^']+\.css)';/g)].map((match) =>
      resolve(root, 'src/web/styles/themes', match[1]!),
    );
    expect(themeImports.length).toBeGreaterThan(0);

    const hostCss = cssFiles(resolve(root, 'src/web/styles')).filter((file) => !file.includes('/styles/themes/'));
    const publicCss = cssFiles(resolve(root, 'public/pico-plugin-ui'));
    const sources = [...themeImports, ...hostCss, ...publicCss, resolve(root, 'src/web/settings-navigation.css')].map(
      (file) => ({ file, text: readFileSync(file, 'utf8') }),
    );
    const defined = new Set(
      sources.flatMap(({ text }) => [...text.matchAll(/(--pico-[\w-]+)\s*:/g)].map((match) => match[1]!)),
    );
    const missing = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/var\(\s*(--pico-[\w-]+)\s*([,)])/g)]
        .filter((match) => match[2] === ')' && !defined.has(match[1]!))
        .map((match) => `${file.slice(root.length + 1)}: ${match[1]}`),
    );
    expect(missing).toEqual([]);
  });

  it('provides dark values for every built-in light color role', () => {
    const directory = resolve(root, 'src/web/styles/themes');
    const files = readdirSync(directory);
    const definitions = (names: string[]) =>
      names.flatMap((name) => [
        ...readFileSync(resolve(directory, name), 'utf8').matchAll(/(--pico-[\w-]+)\s*:\s*([^;]+);/g),
      ]);
    const light = definitions(files.filter((name) => name.endsWith('-light.css')));
    const dark = new Set(definitions(files.filter((name) => name.startsWith('dark-'))).map((match) => match[1]!));
    const missing = light
      .filter((match) => /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|linear-gradient)\(|^\s*(?:white|black)\s*$/i.test(match[2]!))
      .map((match) => match[1]!)
      .filter((name) => !dark.has(name));
    expect(missing).toEqual([]);
  });
});
