const STOPPED_STATES = new Set(['inactive', 'failed']);

/** Restore and restart a stopped systemd Runtime, failing closed at each gate. */
export async function recoverStoppedSystemdUnit(ops) {
  if (!ops || typeof ops.readState !== 'function') {
    throw new TypeError('Systemd recovery requires a readState operation.');
  }

  const state = await ops.readState();
  if (
    !state ||
    !Array.isArray(state.listenerPids) ||
    typeof state.oldProcessAlive !== 'boolean' ||
    typeof state.activeState !== 'string'
  ) {
    throw new Error('Cannot verify that the old Runtime has stopped.');
  }
  if (state.listenerPids.length > 0) {
    throw new Error('A listener is running; refusing to restore Runtime artifacts.');
  }
  if (state.oldProcessAlive) {
    throw new Error('The old Runtime process is still alive; refusing to restore Runtime artifacts.');
  }
  if (!STOPPED_STATES.has(state.activeState)) {
    throw new Error('The systemd unit has not finished stopping; refusing to restore Runtime artifacts.');
  }

  if (typeof ops.assertStopped !== 'function') {
    throw new TypeError('Systemd recovery requires an assertStopped operation.');
  }
  await ops.assertStopped();
  await ops.restore();
  await ops.start();
  await ops.verify();
}
