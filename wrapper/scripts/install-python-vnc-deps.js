import { spawnSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const requirementsPath = join(__dirname, '..', 'src', 'services', 'python-vnc', 'requirements.txt');
const targetDir = join(__dirname, '..', 'dist', 'services', 'python-vnc', '.deps');

if (process.env.SKIP_PYTHON_VNC_DEPS === 'true') {
  console.log('Skipping python-vnc deps install (SKIP_PYTHON_VNC_DEPS=true)');
  process.exit(0);
}

if (!existsSync(requirementsPath)) {
  console.error(`requirements.txt not found at ${requirementsPath}`);
  process.exit(1);
}

if (existsSync(targetDir) && process.env.FORCE_PYTHON_VNC_DEPS !== 'true') {
  try {
    const entries = readdirSync(targetDir);
    if (entries.length > 0) {
      console.log('python-vnc deps already present; skipping install (set FORCE_PYTHON_VNC_DEPS=true to reinstall)');
      process.exit(0);
    }
  } catch (err) {
    console.warn('Unable to inspect python-vnc deps directory; proceeding with install.', err);
  }
}

const python = process.platform === 'win32' ? 'python' : 'python3';
const result = spawnSync(python, [
  '-m',
  'pip',
  'install',
  '--upgrade',
  '-r',
  requirementsPath,
  '--target',
  targetDir
], { stdio: 'inherit' });

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
