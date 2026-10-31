import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_THEME_INHERIT_ROLES,
  MAX_THEME_VARIABLES,
  themeRoleCoverageErrors,
} from '../src/contracts/plugin-theme.js';
import { THEME_ROLE_SCHEMA } from '../src/contracts/theme-role-schema.js';

const root = resolve(import.meta.dirname, '..');
const backgroundRole = '--pico-theme-background-image';

function lightThemeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return lightThemeFiles(path);
    return entry.name.endsWith('-light.css') ? [path] : [];
  });
}

describe('plugin theme role contract', () => {
  it('matches every --pico role declared by the light theme CSS', () => {
    const directory = resolve(root, 'src/web/styles/themes');
    const declared = new Set(
      lightThemeFiles(directory).flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(/(--pico-[a-z0-9-]+)\s*:/g)].map((match) => match[1]!),
      ),
    );
    expect([...THEME_ROLE_SCHEMA].sort()).toEqual([...declared].sort());
    expect(THEME_ROLE_SCHEMA).toContain(backgroundRole);
    expect(MAX_THEME_VARIABLES).toBeGreaterThanOrEqual(THEME_ROLE_SCHEMA.length);
  });

  it('accepts complete coverage through overrides and explicit inheritance', () => {
    expect(
      themeRoleCoverageErrors({
        coverage: 'complete',
        variables: {},
        inheritRoles: THEME_ROLE_SCHEMA,
        background: { entry: 'webui', path: 'assets/background.svg' },
      }),
    ).toEqual([]);

    const [first, ...rest] = THEME_ROLE_SCHEMA;
    expect(
      themeRoleCoverageErrors({
        coverage: 'complete',
        variables: { [first!]: '#fff' },
        inheritRoles: rest,
      }),
    ).toEqual([]);

    expect(
      themeRoleCoverageErrors({
        coverage: 'complete',
        variables: Object.fromEntries(
          THEME_ROLE_SCHEMA.filter((role) => role !== backgroundRole).map((role) => [role, 'initial']),
        ),
        inheritRoles: [backgroundRole],
      }),
    ).toEqual([]);
  });

  it('rejects missing, unknown, duplicate, and overlapping role declarations', () => {
    const [first, ...rest] = THEME_ROLE_SCHEMA;
    const missing = themeRoleCoverageErrors({ coverage: 'complete', variables: {}, inheritRoles: rest });
    expect(missing).toContain(`missing theme role coverage: ${first}`);

    const missingBackground = themeRoleCoverageErrors({
      coverage: 'complete',
      variables: {},
      inheritRoles: THEME_ROLE_SCHEMA.filter((role) => role !== backgroundRole),
      background: { entry: 'webui', path: 'assets/background.svg' },
    });
    expect(missingBackground).toContain(`missing theme role coverage: ${backgroundRole}`);

    const unknown = themeRoleCoverageErrors({
      coverage: 'complete',
      variables: { '--pico-not-a-role': '#fff' },
      inheritRoles: THEME_ROLE_SCHEMA,
    });
    expect(unknown).toContain('unknown theme role: --pico-not-a-role');

    const duplicate = themeRoleCoverageErrors({
      coverage: 'complete',
      variables: {},
      inheritRoles: [first!, first!, ...rest],
    });
    expect(duplicate).toContain(`duplicate inherited theme role: ${first}`);

    const overlap = themeRoleCoverageErrors({
      coverage: 'complete',
      variables: { [first!]: '#fff' },
      inheritRoles: THEME_ROLE_SCHEMA,
    });
    expect(overlap).toContain(`theme role is both overridden and inherited: ${first}`);
  });

  it('bounds inheritance declarations and requires framework background role inheritance', () => {
    const oversized = themeRoleCoverageErrors({
      coverage: 'complete',
      variables: {},
      inheritRoles: [...THEME_ROLE_SCHEMA, '--pico-extra-role'],
    });
    expect(oversized).toContain(`inheritRoles may contain at most ${MAX_THEME_INHERIT_ROLES} roles`);

    const backgroundOverride = themeRoleCoverageErrors({
      coverage: 'complete',
      variables: Object.fromEntries(
        THEME_ROLE_SCHEMA.filter((role) => role !== backgroundRole).map((role) => [role, 'initial']),
      ),
      inheritRoles: [],
    });
    expect(backgroundOverride).toContain('missing theme role coverage: --pico-theme-background-image');

    const directBackground = themeRoleCoverageErrors({
      coverage: 'complete',
      variables: Object.fromEntries(THEME_ROLE_SCHEMA.map((role) => [role, 'initial'])),
    });
    expect(directBackground).toContain('theme background images must use the background asset field and inheritRoles');
  });

  it('keeps legacy sparse themes valid without strict coverage metadata', () => {
    expect(themeRoleCoverageErrors({ variables: { '--pico-accent': '#06f' } })).toEqual([]);
    expect(themeRoleCoverageErrors({ variables: {}, inheritRoles: [] })).toContain(
      'inheritRoles requires coverage: complete',
    );
  });
});
