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

  it('keeps the built-in dark conversation avatar aligned with the Pico mark', () => {
    const definitions = (filename: string) =>
      new Map(
        [
          ...readFileSync(resolve(root, 'src/web/styles/themes', filename), 'utf8').matchAll(
            /(--pico-[\w-]+)\s*:\s*([^;]+);/g,
          ),
        ].map((match) => [match[1]!, match[2]!.trim()]),
      );
    for (const [shell, conversation] of [
      [definitions('dark-shell.css'), definitions('dark-conversation.css')],
      [definitions('dark-legacy.css'), definitions('dark-legacy.css')],
    ] as const) {
      expect(conversation.get('--pico-conversation-avatar-foreground')).toBe(
        shell.get('--pico-shell-brand-mark-welcome-mark-text'),
      );
      expect(conversation.get('--pico-conversation-assistant-avatar-gradient')).toBe(
        `linear-gradient(145deg, ${shell.get('--pico-shell-brand-mark-welcome-mark-surface-gradient-start')}, ${shell.get('--pico-shell-brand-mark-welcome-mark-surface-gradient-end')})`,
      );
    }
  });

  it('keeps host color and typography values theme-tokenized', () => {
    const hostCss = [
      ...cssFiles(resolve(root, 'src/web/styles')).filter((file) => !file.includes('/styles/themes/')),
      resolve(root, 'src/web/settings-navigation.css'),
    ];
    const cssWideOrTransparent = /^(?:transparent|currentcolor|inherit|initial|unset|revert|revert-layer|none)$/i;
    const calculations =
      /\b(?:var|calc|clamp|min|max|env|color-mix|linear-gradient|radial-gradient|conic-gradient)\s*\(/i;
    const namedColors = new Set(
      'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgrey darkgreen darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray grey green greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgrey lightgreen lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(' '),
    );
    const findings: string[] = [];

    for (const file of hostCss) {
      const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (comment) =>
        comment.replace(/[^\n]/g, ' '),
      );
      const declarations = /([\w-]+)\s*:\s*([^;{}]+);/g;
      for (const match of source.matchAll(declarations)) {
        const property = match[1]!.toLowerCase();
        const value = match[2]!.trim();
        const line = source.slice(0, match.index).split('\n').length;
        const location = `${file.slice(root.length + 1)}:${line} ${property}: ${value}`;

        if (
          [
            'color',
            'background-color',
            'border-color',
            'border-top-color',
            'border-right-color',
            'border-bottom-color',
            'border-left-color',
            'outline-color',
            'text-decoration-color',
            'fill',
            'stroke',
          ].includes(property)
        ) {
          const keyword = value.toLowerCase();
          const systemColor =
            /^(?:canvas|canvastext|linktext|visitedtext|activetext|buttonface|buttontext|field|fieldtext|highlight|highlighttext|mark|marktext|graytext)$/i.test(
              value,
            );
          if (
            !value.includes('var(') &&
            !calculations.test(value) &&
            !cssWideOrTransparent.test(keyword) &&
            !systemColor
          ) {
            findings.push(location);
          }
        } else if (
          [
            'background',
            'border',
            'border-top',
            'border-right',
            'border-bottom',
            'border-left',
            'outline',
            'box-shadow',
            'text-shadow',
          ].includes(property)
        ) {
          const hasColorLiteral =
            /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i.test(value) ||
            value.split(/[\s,]+/).some((part) => namedColors.has(part.toLowerCase()));
          if (hasColorLiteral) findings.push(location);
        }

        if (
          ['font', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing'].includes(
            property,
          )
        ) {
          const semanticValue =
            /^(?:inherit|initial|unset|revert|revert-layer|normal|bold|bolder|lighter|italic|oblique|small-caps)$/i.test(
              value,
            );
          if (!value.includes('var(') && !calculations.test(value) && !semanticValue) findings.push(location);
        }
      }
    }

    expect(findings).toEqual([]);
  });
});
