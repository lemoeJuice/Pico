import { describe, expect, it } from 'vitest';
// @ts-expect-error Deployment helper is a plain Node ESM module.
import * as listenersUntyped from '../scripts/deploy/listeners.mjs';

const { parseListenerRows, assertNoConflictingListeners, listenerPidsConflictingWithAddresses, listenerAddressesConflict } = listenersUntyped as unknown as {
  parseListenerRows(output: string): { address: string; pids: number[] }[];
  assertNoConflictingListeners(rows: { address: string; pids: number[] }[], pid: number, addresses: string[]): void;
  listenerPidsConflictingWithAddresses(rows: { address: string; pids: number[] }[], addresses: string[]): number[];
  listenerAddressesConflict(left: string, right: string): boolean;
};

describe('deployment listener inspection', () => {
  it('allows a second process on a distinct concrete local IP', () => {
    const rows = parseListenerRows([
      'LISTEN 0 511 192.0.2.10:4173 0.0.0.0:* users:(("node",pid=1234,fd=20))',
      'LISTEN 0 511 192.0.2.11:4173 0.0.0.0:* users:(("other",pid=5678,fd=4))',
    ].join('\n'));

    expect(() => assertNoConflictingListeners(rows, 1234, ['192.0.2.10'])).not.toThrow();
  });

  it.each([
    ['same address', '192.0.2.10:4173'],
    ['IPv4 wildcard', '0.0.0.0:4173'],
    ['IPv6 wildcard', '[::]:4173'],
  ])('rejects a conflicting %s listener', (_label, endpoint) => {
    const rows = parseListenerRows([
      'LISTEN 0 511 192.0.2.10:4173 0.0.0.0:* users:(("node",pid=1234,fd=20))',
      `LISTEN 0 511 ${endpoint} 0.0.0.0:* users:(("other",pid=5678,fd=4))`,
    ].join('\n'));

    expect(() => assertNoConflictingListeners(rows, 1234, ['192.0.2.10'])).toThrow(/conflicts/);
  });

  it('rejects a Runtime socket shared with another process', () => {
    const rows = [{ address: '192.0.2.10', pids: [1234, 5678] }];
    expect(() => assertNoConflictingListeners(rows, 1234, ['192.0.2.10'])).toThrow(/shared/);
  });

  it('fails closed when a listener PID is not visible or the Pico row disappears', () => {
    const hiddenPid = parseListenerRows('LISTEN 0 511 192.0.2.10:4173 0.0.0.0:* users:(())');
    expect(() => assertNoConflictingListeners(hiddenPid, 1234, ['192.0.2.10'])).toThrow();

    const disappeared = parseListenerRows('LISTEN 0 511 192.0.2.11:4173 0.0.0.0:* users:(("other",pid=5678,fd=4))');
    expect(() => assertNoConflictingListeners(disappeared, 1234, ['192.0.2.10'])).toThrow();
  });

  it('fails closed when ss reports an unreadable listening row', () => {
    expect(() => parseListenerRows('LISTEN 0 511 unreadable')).toThrow(/Cannot parse/);
    expect(() => parseListenerRows('LISTEN 0 511 not-an-ip:4173 0.0.0.0:* users:(())')).toThrow(/Cannot parse/);
  });

  it('canonicalizes equivalent IPv6 and IPv4-mapped addresses', () => {
    const compressed = parseListenerRows('LISTEN 0 511 [2001:db8::1]:4173 *:* users:(("node",pid=1234,fd=20))');
    const expanded = parseListenerRows('LISTEN 0 511 [2001:0db8:0:0:0:0:0:1]:4173 *:* users:(("other",pid=5678,fd=4))');
    const compressedAddress = compressed[0]?.address;
    const expandedAddress = expanded[0]?.address;
    if (compressedAddress === undefined || expandedAddress === undefined) throw new Error('IPv6 listener row was not parsed.');
    expect(compressedAddress).toBe(expandedAddress);
    expect(listenerAddressesConflict(compressedAddress, expandedAddress)).toBe(true);

    const mapped = parseListenerRows('LISTEN 0 511 [::ffff:c000:020a]:4173 *:* users:(("node",pid=1234,fd=20))');
    expect(mapped[0]?.address).toBe('192.0.2.10');
  });

  it('treats compressed IPv6 wildcard as wildcard and permits distinct concrete IPv6 binds', () => {
    const wildcard = parseListenerRows('LISTEN 0 511 [::]:4173 *:* users:(("node",pid=1234,fd=20))');
    const concrete = parseListenerRows('LISTEN 0 511 [2001:db8::2]:4173 *:* users:(("other",pid=5678,fd=4))');
    const first = parseListenerRows('LISTEN 0 511 [2001:db8::1]:4173 *:* users:(("node",pid=1234,fd=20))');
    const second = parseListenerRows('LISTEN 0 511 [2001:db8::2]:4173 *:* users:(("other",pid=5678,fd=4))');
    expect(wildcard[0]?.address).toBe('::');
    expect(() => assertNoConflictingListeners([...wildcard, ...concrete], 1234, ['::'])).toThrow(/conflicts/);
    expect(() => assertNoConflictingListeners([...first, ...second], 1234, ['2001:db8:0:0:0:0:0:1'])).not.toThrow();
  });

  it('treats unknown addresses as conflicting instead of throwing or allowing them', () => {
    expect(() => listenerAddressesConflict('192.0.2.10', 'not-an-ip')).not.toThrow();
    expect(listenerAddressesConflict('192.0.2.10', 'not-an-ip')).toBe(true);
  });

  it('only counts listeners overlapping the Runtime address during recovery', () => {
    const rows = parseListenerRows([
      'LISTEN 0 511 192.0.2.10:4173 *:* users:(("node",pid=1234,fd=20))',
      'LISTEN 0 511 192.0.2.11:4173 *:* users:(("other",pid=5678,fd=4))',
    ].join('\n'));
    expect(listenerPidsConflictingWithAddresses(rows, ['192.0.2.10'])).toEqual([1234]);
  });

  it('blocks recovery for hidden or newly conflicting listeners at the Runtime address', () => {
    const rows = parseListenerRows([
      'LISTEN 0 511 192.0.2.10:4173 *:* users:(("node",pid=1234,fd=20))',
      'LISTEN 0 511 192.0.2.10:4173 *:* users:(())',
    ].join('\n'));
    expect(listenerPidsConflictingWithAddresses(rows, ['192.0.2.10'])).toEqual(expect.arrayContaining([-1, 1234]));
  });

  it('fails closed for a Runtime bound to a wildcard address beside another service', () => {
    const rows = parseListenerRows([
      'LISTEN 0 511 0.0.0.0:4173 0.0.0.0:* users:(("node",pid=1234,fd=20))',
      'LISTEN 0 511 192.0.2.11:4173 0.0.0.0:* users:(("other",pid=5678,fd=4))',
    ].join('\n'));

    expect(() => assertNoConflictingListeners(rows, 1234, ['0.0.0.0'])).toThrow(/conflicts/);
  });
});
