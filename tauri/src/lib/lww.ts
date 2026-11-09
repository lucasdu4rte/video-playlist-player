export type Stamped<T> = { value: T; updatedAt: number };

export function newerKeys<T>(
  local: Record<string, number>,
  remote: Record<string, Stamped<T>>
): string[] {
  return Object.keys(remote).filter(
    (key) => remote[key].updatedAt > (local[key] ?? 0)
  );
}
