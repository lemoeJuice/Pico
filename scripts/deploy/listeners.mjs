import { isIP } from 'node:net';

function addressFromEndpoint(endpoint) {
  if (endpoint.startsWith('[')) {
    const end = endpoint.indexOf(']');
    if (end < 0) return undefined;
    return canonicalAddress(endpoint.slice(1, end).split('%', 1)[0].toLowerCase());
  }
  const separator = endpoint.lastIndexOf(':');
  if (separator < 0) return undefined;
  const address = endpoint.slice(0, separator).toLowerCase();
  return address === '*' ? address : canonicalAddress(address);
}

export function parseListenerRows(output) {
  const rows = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== 'LISTEN') continue;
    if (columns.length < 4) throw new Error('Cannot parse a listening socket reported by ss.');
    const address = addressFromEndpoint(columns[3]);
    if (!address) throw new Error('Cannot parse the local address of a listening socket reported by ss.');
    const pids = [...new Set([...line.matchAll(/\bpid=(\d+)/g)].map((match) => Number(match[1])))];
    rows.push({ address, pids });
  }
  return rows;
}

function canonicalAddress(address) {
  if (address === '*') return address;
  const family = isIP(address);
  if (family === 4) return address.split('.').map((part) => String(Number(part))).join('.');
  if (family !== 6) return undefined;

  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const parseWords = (half) => {
    if (!half) return [];
    const parts = half.split(':');
    const words = [];
    for (const part of parts) {
      if (part.includes('.')) {
        const octets = part.split('.').map(Number);
        if (octets.length !== 4) return undefined;
        words.push(((octets[0] << 8) | octets[1]).toString(16));
        words.push(((octets[2] << 8) | octets[3]).toString(16));
      } else {
        words.push(Number.parseInt(part, 16).toString(16));
      }
    }
    return words;
  };
  const left = parseWords(halves[0]);
  const right = parseWords(halves[1] ?? '');
  if (!left || !right) return undefined;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const words = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (words.length !== 8) return undefined;
  if (words.every((word) => word === '0')) return '::';
  if (words.slice(0, 7).every((word) => word === '0') && words[7] === '1') return '::1';
  if (words.slice(0, 5).every((word) => word === '0') && words[5] === 'ffff') {
    const high = Number.parseInt(words[6], 16);
    const low = Number.parseInt(words[7], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return words.join(':');
}

function wildcard(address) {
  return address === '*' || address === '0.0.0.0' || address === '::';
}

// Unknown and wildcard addresses overlap conservatively. Only distinct concrete
// IP binds are safe to coexist on a shared port.
export function listenerAddressesConflict(left, right) {
  const a = canonicalAddress(typeof left === 'string' ? left.toLowerCase() : '');
  const b = canonicalAddress(typeof right === 'string' ? right.toLowerCase() : '');
  if (!a || !b) return true;
  return wildcard(a) || wildcard(b) || a === b || !a.includes(':') !== !b.includes(':');
}

export function assertNoConflictingListeners(rows, targetPid, targetAddresses) {
  const targetRows = rows.filter((row) => row.pids.includes(targetPid));
  if (targetRows.length === 0 || targetRows.some((row) => !targetAddresses.includes(row.address))) {
    throw new Error('The verified Runtime listener address changed; refusing to continue.');
  }
  assertAddressesUncontended(rows, targetPid, targetAddresses);
}

export function assertAddressesUncontended(rows, targetPid, targetAddresses) {
  for (const row of rows) {
    if (row.pids.includes(targetPid)) {
      if (row.pids.some((pid) => pid !== targetPid)) throw new Error('The Runtime listener is shared with another process.');
      continue;
    }
    if (targetAddresses.some((address) => listenerAddressesConflict(address, row.address))) {
      throw new Error('Another listener conflicts with the Runtime address on the deployment port.');
    }
  }
}

export function listenerPidsConflictingWithAddresses(rows, addresses) {
  const pids = new Set();
  for (const row of rows) {
    if (!addresses.some((address) => listenerAddressesConflict(address, row.address))) continue;
    if (row.pids.length === 0) pids.add(-1);
    else for (const pid of row.pids) pids.add(pid);
  }
  return [...pids];
}
