import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GenericRunner } from './generic-runner.js';

/**
 * Real execution tests - These tests actually spawn the installed AI tools
 * and verify they can create files.
 *
 * These tests require:
 * - codex: PowerShell script (codex.ps1) installed
 * - gemini: gemini CLI installed
 * - rev: rev CLI installed
 * - claude: claude CLI installed
 *
 * Run these tests with: npm test -- wrapper real-execution
 */

describe('Real Tool Execution Tests', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'real-exec-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Codex - Real Execution', () => {
    it('should spawn codex with correct arguments', async () => {
      const runner = new GenericRunner({
        runId: 'test-codex-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'codex'
      });

      const { args } = runner.buildCommand('test prompt', false);
      const cmd = runner.getCommand();

      console.log(`Testing codex spawn: ${cmd} ${args.join(' ')}`);

      return new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd, args, {
          cwd: testDir,
          shell: false,  // Use false for .cmd files on Windows
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        const timeout = setTimeout(() => {
          proc.kill();
          reject(new Error('Codex command timed out'));
        }, 5000);

        proc.on('close', (code) => {
          clearTimeout(timeout);
          console.log(`Codex process closed with code: ${code}`);
          console.log(`Stdout: ${stdout.substring(0, 200)}`);
          console.log(`Stderr: ${stderr.substring(0, 200)}`);

          // We don't expect success since we're just testing spawn
          // The important thing is that it doesn't fail with ENOENT
          if (code !== null && !stderr.includes('ENOENT')) {
            resolve();
          } else {
            reject(new Error(`Codex spawn failed with ENOENT or unexpected error`));
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          console.log(`Codex error: ${err.message}`);
          reject(err);
        });
      });
    }, 10000);

    it('should create hello.js file via codex', async () => {
      const runner = new GenericRunner({
        runId: 'test-codex-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'codex'
      });

      const prompt = 'Create a file named hello.js that logs "Hello, World!" to the console. Do not ask any questions, just create the file.';
      const { args } = runner.buildCommand(prompt, false);
      const cmd = runner.getCommand();

      console.log(`Testing codex file creation...`);

      return new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd, args, {
          cwd: testDir,
          shell: false,  // Use false for .cmd files on Windows
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30000
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        const timeout = setTimeout(() => {
          proc.kill();
          // Check if file was created even if timeout
          checkFile();
        }, 30000);

        proc.on('close', (code) => {
          clearTimeout(timeout);
          console.log(`Codex exited with code: ${code}`);
          console.log(`Stdout: ${stdout.substring(0, 500)}`);
          checkFile();
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          console.log(`Codex error: ${err.message}`);
          reject(err);
        });

        function checkFile() {
          const helloPath = join(testDir, 'hello.js');
          if (existsSync(helloPath)) {
            const content = readFileSync(helloPath, 'utf-8');
            console.log(`hello.js created:\n${content}`);
            expect(content).toBeTruthy();
            resolve();
          } else {
            reject(new Error('hello.js was not created by codex'));
          }
        }
      });
    }, 60000);
  });

  describe('Gemini - Real Execution', () => {
    it('should spawn gemini with correct arguments', async () => {
      const runner = new GenericRunner({
        runId: 'test-gemini-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'gemini'
      });

      const { args } = runner.buildCommand('test prompt', false);
      const cmd = runner.getCommand();

      console.log(`Testing gemini spawn: ${cmd} ${args.join(' ')}`);

      return new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd, args, {
          cwd: testDir,
          shell: false,  // gemini is a .cmd file that can be spawned directly
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        const timeout = setTimeout(() => {
          proc.kill();
          reject(new Error('Gemini command timed out'));
        }, 5000);

        proc.on('close', (code) => {
          clearTimeout(timeout);
          console.log(`Gemini process closed with code: ${code}`);
          console.log(`Stdout: ${stdout.substring(0, 200)}`);
          console.log(`Stderr: ${stderr.substring(0, 200)}`);

          if (code !== null && !stderr.includes('ENOENT')) {
            resolve();
          } else {
            reject(new Error(`Gemini spawn failed with ENOENT or unexpected error`));
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          console.log(`Gemini error: ${err.message}`);
          reject(err);
        });
      });
    }, 10000);

    it('should create hello.js file via gemini', async () => {
      const runner = new GenericRunner({
        runId: 'test-gemini-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'gemini'
      });

      const prompt = 'Create a file named hello.js that logs "Hello, World!" to the console. Do not ask any questions, just create the file.';
      const { args } = runner.buildCommand(prompt, false);
      const cmd = runner.getCommand();

      console.log(`Testing gemini file creation...`);

      return new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd, args, {
          cwd: testDir,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30000
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        const timeout = setTimeout(() => {
          proc.kill();
          checkFile();
        }, 30000);

        proc.on('close', (code) => {
          clearTimeout(timeout);
          console.log(`Gemini exited with code: ${code}`);
          console.log(`Stdout: ${stdout.substring(0, 500)}`);
          checkFile();
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          console.log(`Gemini error: ${err.message}`);
          reject(err);
        });

        function checkFile() {
          const helloPath = join(testDir, 'hello.js');
          if (existsSync(helloPath)) {
            const content = readFileSync(helloPath, 'utf-8');
            console.log(`hello.js created:\n${content}`);
            expect(content).toBeTruthy();
            resolve();
          } else {
            reject(new Error('hello.js was not created by gemini'));
          }
        }
      });
    }, 60000);
  });

  describe('Rev - Real Execution', () => {
    it('should spawn rev with correct arguments', async () => {
      const runner = new GenericRunner({
        runId: 'test-rev-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev'
      });

      const { args } = runner.buildCommand('test prompt', false);
      const cmd = runner.getCommand();

      console.log(`Testing rev spawn: ${cmd} ${args.join(' ')}`);

      return new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd, args, {
          cwd: testDir,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        const timeout = setTimeout(() => {
          proc.kill();
          reject(new Error('Rev command timed out'));
        }, 5000);

        proc.on('close', (code) => {
          clearTimeout(timeout);
          console.log(`Rev process closed with code: ${code}`);
          console.log(`Stdout: ${stdout.substring(0, 200)}`);
          console.log(`Stderr: ${stderr.substring(0, 200)}`);

          if (code !== null && !stderr.includes('ENOENT')) {
            resolve();
          } else {
            reject(new Error(`Rev spawn failed with ENOENT or unexpected error`));
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          console.log(`Rev error: ${err.message}`);
          reject(err);
        });
      });
    }, 10000);

    it('should create hello.js file via rev', async () => {
      const runner = new GenericRunner({
        runId: 'test-rev-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false,
        workerType: 'rev',
        provider: 'ollama',
        model: 'glm-4.7:cloud'
      });

      const prompt = 'Create a file named hello.js that logs "Hello, World!" to the console. Do not ask any questions, just create the file.';
      const { args } = runner.buildCommand(prompt, false);
      const cmd = runner.getCommand();

      console.log(`Testing rev file creation with provider ollama and model glm-4.7:cloud...`);

      return new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd, args, {
          cwd: testDir,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30000
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        const timeout = setTimeout(() => {
          proc.kill();
          checkFile();
        }, 30000);

        proc.on('close', (code) => {
          clearTimeout(timeout);
          console.log(`Rev exited with code: ${code}`);
          console.log(`Stdout: ${stdout.substring(0, 500)}`);
          checkFile();
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          console.log(`Rev error: ${err.message}`);
          reject(err);
        });

        function checkFile() {
          const helloPath = join(testDir, 'hello.js');
          if (existsSync(helloPath)) {
            const content = readFileSync(helloPath, 'utf-8');
            console.log(`hello.js created:\n${content}`);
            expect(content).toBeTruthy();
            resolve();
          } else {
            reject(new Error('hello.js was not created by rev'));
          }
        }
      });
    }, 60000);
  });

  describe('Claude - Real Execution', () => {
    it('should spawn claude with correct arguments', async () => {
      const { ClaudeRunner } = await import('./claude-runner.js');

      const runner = new ClaudeRunner({
        runId: 'test-claude-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false
      });

      const { args } = runner.buildCommand();
      const cmd = runner.getCommand();

      console.log(`Testing claude spawn: ${cmd} ${args.join(' ')}`);

      return new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd, args, {
          cwd: testDir,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        const timeout = setTimeout(() => {
          proc.kill();
          reject(new Error('Claude command timed out'));
        }, 5000);

        proc.on('close', (code) => {
          clearTimeout(timeout);
          console.log(`Claude process closed with code: ${code}`);
          console.log(`Stdout: ${stdout.substring(0, 200)}`);
          console.log(`Stderr: ${stderr.substring(0, 200)}`);

          if (code !== null && !stderr.includes('ENOENT')) {
            resolve();
          } else {
            reject(new Error(`Claude spawn failed with ENOENT or unexpected error`));
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          console.log(`Claude error: ${err.message}`);
          reject(err);
        });
      });
    }, 10000);

    it('should create hello.js file via claude', async () => {
      const { ClaudeRunner } = await import('./claude-runner.js');

      const runner = new ClaudeRunner({
        runId: 'test-claude-run',
        capabilityToken: 'test-token',
        workingDir: testDir,
        autonomous: false
      });

      // In interactive mode, we need to send the command via stdin
      const prompt = 'Create a file named hello.js that logs "Hello, World!" to the console. Do not ask any questions, just create the file.';
      const { args } = runner.buildCommand();
      const cmd = runner.getCommand();

      console.log(`Testing claude file creation (interactive mode)...`);

      return new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd, args, {
          cwd: testDir,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30000
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
          // Send the command when we see the prompt
          if (stdout.includes('user') || stdout.includes('>') || stdout.includes('$')) {
            proc.stdin?.write(prompt + '\n');
          }
        });

        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        // Wait a bit then send the command
        setTimeout(() => {
          proc.stdin?.write(prompt + '\n');
        }, 1000);

        const timeout = setTimeout(() => {
          proc.kill();
          checkFile();
        }, 30000);

        proc.on('close', (code) => {
          clearTimeout(timeout);
          console.log(`Claude exited with code: ${code}`);
          console.log(`Stdout: ${stdout.substring(0, 500)}`);
          checkFile();
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          console.log(`Claude error: ${err.message}`);
          reject(err);
        });

        function checkFile() {
          const helloPath = join(testDir, 'hello.js');
          if (existsSync(helloPath)) {
            const content = readFileSync(helloPath, 'utf-8');
            console.log(`hello.js created:\n${content}`);
            expect(content).toBeTruthy();
            resolve();
          } else {
            reject(new Error('hello.js was not created by claude'));
          }
        }
      });
    }, 60000);
  });
});