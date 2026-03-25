import { describe, expect, it } from 'vitest';
import { buildRunChangeReport, countDiffStats, extractEventChangeDetails, splitDiffByFile } from './changes';

describe('run change helpers', () => {
  it('extracts changed files from fileChange events', () => {
    const details = extractEventChangeDetails({
      type: 'info',
      data: JSON.stringify({
        method: 'item/completed',
        params: {
          item: {
            type: 'fileChange',
            changes: [
              { path: 'C:\\Users\\TimShelton\\source\\repos\\VisualSynth\\src\\one.ts' },
              { path: 'C:\\Users\\TimShelton\\source\\repos\\VisualSynth\\src\\two.ts' },
            ],
          },
        },
      }),
    } as any);

    expect(details).toEqual({
      files: ['src/one.ts', 'src/two.ts'],
      diff: null,
    });
  });

  it('splits a multi-file diff into per-file blocks', () => {
    const diff = [
      'diff --git a/src/one.ts b/src/one.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/src/two.ts b/src/two.ts',
      '@@ -1 +1 @@',
      '-c',
      '+d',
    ].join('\n');

    expect(splitDiffByFile(diff)).toEqual([
      { path: 'src/one.ts', diff: 'diff --git a/src/one.ts b/src/one.ts\n@@ -1 +1 @@\n-a\n+b' },
      { path: 'src/two.ts', diff: 'diff --git a/src/two.ts b/src/two.ts\n@@ -1 +1 @@\n-c\n+d' },
    ]);
  });

  it('counts added and removed lines excluding diff headers', () => {
    const diff = [
      'diff --git a/src/one.ts b/src/one.ts',
      '--- a/src/one.ts',
      '+++ b/src/one.ts',
      '@@ -1 +1,2 @@',
      '-old',
      '+new',
      '+extra',
    ].join('\n');

    expect(countDiffStats(diff)).toEqual({ additions: 2, deletions: 1 });
  });

  it('builds a file report with latest diffs', () => {
    const diff = [
      'diff --git a/src/one.ts b/src/one.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');

    const report = buildRunChangeReport([
      {
        id: 1,
        type: 'info',
        timestamp: 10,
        data: JSON.stringify({
          method: 'item/completed',
          params: {
            item: {
              type: 'fileChange',
              changes: [{ path: 'C:\\Users\\TimShelton\\source\\repos\\VisualSynth\\src\\one.ts' }],
            },
          },
        }),
      },
      {
        id: 2,
        type: 'info',
        timestamp: 20,
        data: JSON.stringify({
          method: 'turn/diff/updated',
          params: { diff },
        }),
      },
    ] as any);

    expect(report).toEqual([
      {
        path: 'src/one.ts',
        diff,
        updatedAt: 20,
        additions: 1,
        deletions: 1,
      },
    ]);
  });
});
