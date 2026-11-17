export function shortenDir(dir: string | null | undefined, home?: string): string;
export function filterProjects<T extends { name: string; directory: string }>(
  projects: readonly T[],
  query: string | null | undefined,
): T[];
