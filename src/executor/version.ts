export const PICO_EXECUTOR_VERSION = process.env.PICO_EXECUTOR_VERSION ?? process.env.npm_package_version ?? '0.2.2';

export function compareExecutorVersions(left: string, right: string): number | null {
  const parse = (value: string): number[] | null => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
    return match ? match.slice(1).map(Number) : null;
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}
