#!/usr/bin/env node

import { Command } from 'commander';
import { config, validateConfig } from './config.js';
import { ClaudeRunner } from './services/claude-runner.js';
import { testConnection } from './services/gateway-client.js';

const program = new Command();

program
  .name('claude-runner')
  .description('Claude Code wrapper for Connect-Back Gateway')
  .version('1.0.0');

program
  .command('start')
  .description('Start a Claude Code run')
  .requiredOption('--run-id <id>', 'Run ID from gateway')
  .requiredOption('--token <token>', 'Capability token from gateway')
  .option('--cmd <command>', 'Claude Code command/prompt')
  .option('--cwd <path>', 'Working directory (defaults to current)')
  .action(async (options) => {
    try {
      validateConfig();
    } catch (err: any) {
      console.error(`Configuration error: ${err.message}`);
      console.error('Make sure HMAC_SECRET is set in .env or environment');
      process.exit(1);
    }

    console.log('Testing gateway connection...');
    const connected = await testConnection();
    if (!connected) {
      console.error(`Cannot connect to gateway at ${config.gatewayUrl}`);
      console.error('Make sure the gateway is running and GATEWAY_URL is correct');
      process.exit(1);
    }
    console.log('Gateway connection OK');

    const runner = new ClaudeRunner({
      runId: options.runId,
      capabilityToken: options.token,
      workingDir: options.cwd
    });

    runner.on('stdout', (data) => process.stdout.write(data));
    runner.on('stderr', (data) => process.stderr.write(data));
    runner.on('exit', (code) => {
      console.log(`\nClaude Code finished with exit code ${code}`);
      process.exit(code);
    });

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nReceived SIGINT, stopping...');
      await runner.stop();
    });

    process.on('SIGTERM', async () => {
      console.log('\nReceived SIGTERM, stopping...');
      await runner.stop();
    });

    try {
      await runner.start(options.cmd);
    } catch (err: any) {
      console.error(`Failed to start: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('assist')
  .description('Start a tmate assist session and post URL to gateway')
  .requiredOption('--run-id <id>', 'Run ID from gateway')
  .requiredOption('--token <token>', 'Capability token from gateway')
  .option('--cwd <path>', 'Working directory (defaults to current)')
  .action(async (options) => {
    try {
      validateConfig();
    } catch (err: any) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }

    const runner = new ClaudeRunner({
      runId: options.runId,
      capabilityToken: options.token,
      workingDir: options.cwd
    });

    const url = await runner.startAssistSession();
    if (url) {
      console.log('\n=== Assist Session Ready ===');
      console.log(`Connect: ${url}`);
      console.log('Session URL has been sent to the gateway.');
      console.log('The session will remain active until you close this terminal.');
    } else {
      console.error('Failed to start assist session');
      process.exit(1);
    }

    // Keep process alive
    process.on('SIGINT', () => {
      console.log('\nAssist session ended');
      process.exit(0);
    });
  });

program
  .command('test-connection')
  .description('Test connectivity to the gateway')
  .action(async () => {
    console.log(`Testing connection to ${config.gatewayUrl}...`);
    const connected = await testConnection();
    if (connected) {
      console.log('✓ Connection successful');
    } else {
      console.error('✗ Connection failed');
      process.exit(1);
    }
  });

program
  .command('info')
  .description('Show configuration info')
  .action(() => {
    console.log('Claude Runner Configuration:');
    console.log(`  Gateway URL: ${config.gatewayUrl}`);
    console.log(`  HMAC Secret: ${config.hmacSecret ? '(set)' : '(not set)'}`);
    console.log(`  Claude Command: ${config.claudeCommand}`);
    console.log(`  Working Dir: ${config.projectRoot}`);
    console.log(`  Runs Dir: ${config.runsDir}`);
    console.log(`  Allow Self-Signed: ${config.allowSelfSignedCerts}`);
  });

program.parse();
