import type { LogEvent } from '../../components/ui/LiveLogViewer';

export interface EventChangeDetails {
  files: string[];
  diff: string | null;
}

export interface ChangedFileReport {
  path: string;
  diff: string | null;
  updatedAt: number;
  additions: number;
  deletions: number;
}

function normalizeDisplayPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function parseInfoPayload(data: string): any | null {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function shortenPath(rawPath: string): string {
  const normalized = rawPath.replace(/\//g, '\\');
  const marker = '\\source\\repos\\';
  const markerIndex = normalized.toLowerCase().indexOf(marker);
  if (markerIndex >= 0) {
    const afterRepo = normalized.slice(markerIndex + marker.length);
    const parts = afterRepo.split('\\');
    if (parts.length > 1) return parts.slice(1).join('\\');
  }
  return normalized.replace(/^[A-Za-z]:\\/, '');
}

export function splitDiffByFile(diff: string): Array<{ path: string; diff: string }> {
  const lines = diff.split('\n');
  const blocks: Array<{ path: string; diff: string }> = [];
  let currentPath: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentPath) return;
    blocks.push({ path: currentPath, diff: currentLines.join('\n') });
    currentPath = null;
    currentLines = [];
  };

  for (const line of lines) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) {
      flush();
        currentPath = normalizeDisplayPath(match[2]);
      currentLines = [line];
      continue;
    }
    if (currentPath) currentLines.push(line);
  }

  flush();
  return blocks;
}

export function countDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

export function extractEventChangeDetails(event: Pick<LogEvent, 'type' | 'data'>): EventChangeDetails | null {
  if (event.type !== 'info') return null;
  const payload = parseInfoPayload(event.data);
  const method = payload?.method;
  const params = payload?.params ?? {};
  const item = params?.item ?? {};

  if ((method === 'item/started' || method === 'item/completed') && item?.type === 'fileChange') {
    const files = Array.isArray(item?.changes)
      ? item.changes
          .map((change: any) => (typeof change?.path === 'string' ? normalizeDisplayPath(shortenPath(change.path)) : null))
          .filter((value: string | null): value is string => Boolean(value))
      : [];
    if (files.length === 0) return null;
    return { files, diff: null };
  }

  if (method === 'turn/diff/updated') {
    const diff = typeof params?.diff === 'string' ? params.diff : '';
    const files = splitDiffByFile(diff).map((entry) => entry.path);
    return files.length > 0 ? { files, diff } : null;
  }

  return null;
}

export function buildRunChangeReport(events: LogEvent[]): ChangedFileReport[] {
  const files = new Map<string, ChangedFileReport>();

  for (const event of events) {
    const details = extractEventChangeDetails(event);
    if (!details) continue;

    if (details.diff) {
      for (const block of splitDiffByFile(details.diff)) {
        const stats = countDiffStats(block.diff);
        files.set(block.path, {
          path: block.path,
          diff: block.diff,
          updatedAt: event.timestamp,
          additions: stats.additions,
          deletions: stats.deletions,
        });
      }
      continue;
    }

    for (const path of details.files) {
      const existing = files.get(path);
      files.set(path, {
        path,
        diff: existing?.diff ?? null,
        updatedAt: event.timestamp,
        additions: existing?.additions ?? 0,
        deletions: existing?.deletions ?? 0,
      });
    }
  }

  return Array.from(files.values()).sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
}
