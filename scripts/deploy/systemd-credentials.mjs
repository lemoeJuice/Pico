// Values are inspected in memory only and must never appear in diagnostics.
export function assertSystemdTokenSource({
  unitEnvironment,
  managerEnvironment,
  unsetEnvironment,
  environmentFiles,
  execStart,
  userManager,
  token,
}) {
  if (environmentFiles)
    throw new Error('The systemd unit uses EnvironmentFiles; its credential source cannot be verified safely.');
  if (
    unsetEnvironment
      .split(/\s+/)
      .some((entry) => entry === '*' || entry === 'PICO_ACCESS_TOKEN' || entry.startsWith('PICO_ACCESS_TOKEN='))
  ) {
    throw new Error('The systemd unit removes PICO_ACCESS_TOKEN with UnsetEnvironment; no process was stopped.');
  }
  if (execStart.includes(token))
    throw new Error('The systemd unit appears to pass a credential in ExecStart; refusing to expose it further.');
  const assignment = `PICO_ACCESS_TOKEN=${token}`;
  const unitHasToken = /(?:^|\s|["'])PICO_ACCESS_TOKEN=/.test(unitEnvironment);
  const unitTokens = unitEnvironment.split(/\s+/).filter((item) => item.startsWith('PICO_ACCESS_TOKEN='));
  const managerTokens = managerEnvironment.split('\n').filter((item) => item.startsWith('PICO_ACCESS_TOKEN='));
  const unitMatches = unitTokens.length === 1 && unitTokens[0] === assignment;
  const managerMatches = managerTokens.length === 1 && managerTokens[0] === assignment;
  if (!unitMatches && (unitHasToken || !userManager || !managerMatches)) {
    throw new Error(
      'The systemd unit or user manager does not supply the current Runtime token; no process was stopped.',
    );
  }
}
