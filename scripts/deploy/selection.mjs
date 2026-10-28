const validManifest = (manifest) => manifest?.targets && manifest?.checks?.files;

function changedPaths(currentManifest, baselineManifest, target) {
  const current = currentManifest?.targets?.[target]?.files ?? {};
  const baseline = baselineManifest?.targets?.[target]?.files ?? {};
  return [...new Set([...Object.keys(current), ...Object.keys(baseline)])]
    .filter((file) => current[file] !== baseline[file])
    .sort();
}

/** Validate an explicit deployment scope without deriving it from a deployment plan. */
export function selectDeploymentScope({ options, currentManifest, baselineManifest, availablePluginIds = [] }) {
  const errors = [];
  const warnings = [];
  const pluginIds = [...new Set(options?.pluginIds ?? [])];
  const full = options?.full === true;
  const web = options?.web === true;
  const checks = options?.checks === true;
  const acceptWarnings = options?.acceptWarnings === true;
  const scope = { full, mainWeb: web, pluginIds, checks };

  if (!validManifest(currentManifest)) errors.push('Current release manifest is invalid.');
  if (full && (web || pluginIds.length || checks))
    errors.push('--full cannot be combined with --web, plugin UI, or --checks.');
  if (checks && (web || pluginIds.length)) errors.push('--checks cannot be combined with --web or plugin UI.');
  if (!full && !web && !pluginIds.length && !checks)
    errors.push('Select a deployment scope: --full, --web, a plugin UI, or --checks.');
  for (const id of pluginIds) {
    if (typeof id !== 'string' || !availablePluginIds.includes(id))
      errors.push(`Plugin UI "${id}" has no available source entry.`);
    else if (validManifest(currentManifest) && !currentManifest.targets[`plugin-ui:${id}`])
      errors.push(`Current release manifest is missing target plugin-ui:${id}.`);
  }
  if (!full && (web || pluginIds.length) && !baselineManifest)
    errors.push('A trusted baseline is required for a partial web or plugin UI scope.');

  if (errors.length || !validManifest(currentManifest)) {
    return { ok: false, blocked: true, scope, warnings, errors };
  }

  if (full) {
    if (currentManifest.unknownPaths?.length)
      warnings.push('Unknown source paths remain unclassified and are not represented in the release manifest.');
    const blocked = warnings.length > 0 && !acceptWarnings;
    return { ok: !blocked, blocked, scope, warnings, errors };
  }

  const selected = new Set([...(web ? ['web'] : []), ...pluginIds.map((id) => `plugin-ui:${id}`)]);
  if (checks && !selected.size) {
    return { ok: true, blocked: false, scope, warnings, errors };
  }
  const unselectedChanged = Object.keys({ ...currentManifest.targets, ...baselineManifest.targets })
    .filter((target) => !selected.has(target) && changedPaths(currentManifest, baselineManifest, target).length)
    .sort();
  if (unselectedChanged.length)
    warnings.push(`Unselected release targets also changed: ${unselectedChanged.join(', ')}.`);
  const selectedFullChanges = [...selected].flatMap((target) => {
    const currentTarget = currentManifest.targets[target];
    const baselineTarget = baselineManifest.targets[target];
    const files = [
      ...new Set([...Object.keys(currentTarget?.files ?? {}), ...Object.keys(baselineTarget?.files ?? {})]),
    ];
    return files
      .filter((file) => currentTarget?.files?.[file] !== baselineTarget?.files?.[file])
      .filter((file) => (currentTarget?.actions?.[file] ?? baselineTarget?.actions?.[file])?.action === 'full')
      .map((file) => `${target}:${file}`);
  });
  if (selectedFullChanges.length)
    warnings.push(`Selected targets include changes classified for full release: ${selectedFullChanges.join(', ')}.`);
  if (currentManifest.unknownPaths?.length)
    warnings.push('Unknown source paths exist outside the selected release scope.');
  const blocked = errors.length > 0 || (warnings.length > 0 && !acceptWarnings);
  return { ok: !blocked, blocked, scope, warnings, errors };
}
