import { cpSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, '..', 'src', 'services', 'python-vnc');
const destDir = join(__dirname, '..', 'dist', 'services', 'python-vnc');

if (!existsSync(srcDir)) {
  console.error(`python-vnc source not found at ${srcDir}`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
cpSync(srcDir, destDir, { recursive: true });
console.log(`Copied python-vnc to ${destDir}`);
