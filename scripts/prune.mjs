#!/usr/bin/env node
/**
 * Prune old runs and artifacts based on retention policy
 */

import Database from 'better-sqlite3';
import { existsSync, rmSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const dataDir = join(projectRoot, '.data');
const dbPath = join(dataDir, 'db.sqlite');
const artifactsDir = join(dataDir, 'artifacts');
const runsDir = join(dataDir, 'runs');

// Default retention: 30 days
const RETENTION_DAYS = parseInt(process.env.RUN_RETENTION_DAYS || '30', 10);
const RETENTION_SECONDS = RETENTION_DAYS * 24 * 60 * 60;

console.log(`Pruning runs older than ${RETENTION_DAYS} days...`);

if (!existsSync(dbPath)) {
  console.log('No database found. Nothing to prune.');
  process.exit(0);
}

const db = new Database(dbPath);
const cutoff = Math.floor(Date.now() / 1000) - RETENTION_SECONDS;

// Find old runs
const oldRuns = db.prepare(`
  SELECT id FROM runs
  WHERE created_at < ? AND status IN ('done', 'failed')
`).all(cutoff);

console.log(`Found ${oldRuns.length} runs to prune`);

let artifactsDeleted = 0;
let filesDeleted = 0;

for (const run of oldRuns) {
  console.log(`  Pruning run: ${run.id}`);

  // Get artifacts for this run
  const artifacts = db.prepare('SELECT path FROM artifacts WHERE run_id = ?').all(run.id);

  // Delete artifact files
  for (const artifact of artifacts) {
    if (existsSync(artifact.path)) {
      try {
        rmSync(artifact.path);
        artifactsDeleted++;
      } catch (err) {
        console.error(`    Failed to delete: ${artifact.path}`);
      }
    }
  }

  // Delete run directory
  const runDir = join(runsDir, run.id);
  if (existsSync(runDir)) {
    try {
      rmSync(runDir, { recursive: true });
    } catch (err) {
      console.error(`    Failed to delete run dir: ${runDir}`);
    }
  }

  // Delete artifact directory
  const artifactDir = join(artifactsDir, run.id);
  if (existsSync(artifactDir)) {
    try {
      rmSync(artifactDir, { recursive: true });
    } catch (err) {
      console.error(`    Failed to delete artifact dir: ${artifactDir}`);
    }
  }

  // Delete from database (cascades to events, commands, artifacts)
  db.prepare('DELETE FROM runs WHERE id = ?').run(run.id);
}

// Clean up orphaned directories
function cleanOrphanedDirs(baseDir) {
  if (!existsSync(baseDir)) return 0;

  let cleaned = 0;
  const entries = readdirSync(baseDir);

  for (const entry of entries) {
    const path = join(baseDir, entry);
    if (statSync(path).isDirectory()) {
      // Check if run exists in database
      const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(entry);
      if (!run) {
        console.log(`  Cleaning orphaned directory: ${entry}`);
        try {
          rmSync(path, { recursive: true });
          cleaned++;
        } catch (err) {
          console.error(`    Failed to clean: ${path}`);
        }
      }
    }
  }

  return cleaned;
}

console.log('Cleaning orphaned directories...');
filesDeleted += cleanOrphanedDirs(runsDir);
filesDeleted += cleanOrphanedDirs(artifactsDir);

// Clean old nonces
const noncesDeleted = db.prepare('DELETE FROM nonces WHERE created_at < ?').run(cutoff - 3600);
console.log(`Cleaned ${noncesDeleted.changes} expired nonces`);

// Clean old sessions
const sessionsDeleted = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Math.floor(Date.now() / 1000));
console.log(`Cleaned ${sessionsDeleted.changes} expired sessions`);

// Vacuum database
console.log('Vacuuming database...');
db.exec('VACUUM');

db.close();

console.log(`
Prune complete:
  Runs deleted: ${oldRuns.length}
  Artifacts deleted: ${artifactsDeleted}
  Orphaned dirs cleaned: ${filesDeleted}
`);
