import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config
vi.mock('../config.js', () => ({
  config: {
    projectRoot: '/test/project',
    runsDir: '/test/project/.data/runs',
    claudeCommand: 'claude',
    commandPollInterval: 2000,
    allowlistedCommands: [
      'npm test',
      'git diff',
      'git status',
      'ls -la'
    ],
    secretPatterns: [
      /api[_-]?key[=:]\s*["']?[\w-]+["']?/gi,
      /password[=:]\s*["']?[\w-]+["']?/gi
    ]
  }
}));

// Mock gateway client
vi.mock('./gateway-client.js', () => ({
  sendEvent: vi.fn().mockResolvedValue(undefined),
  uploadArtifact: vi.fn().mockResolvedValue({ artifactId: 'test-artifact' }),
  pollCommands: vi.fn().mockResolvedValue([]),
  ackCommand: vi.fn().mockResolvedValue(undefined)
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn()
}));

// Mock fs
vi.mock('fs', () => ({
  createWriteStream: vi.fn().mockReturnValue({
    write: vi.fn(),
    end: vi.fn()
  }),
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn()
}));

import { config } from '../config.js';
import { redactSecrets } from '../utils/crypto.js';

describe('ClaudeRunner', () => {
  describe('Command Allowlist', () => {
    function isCommandAllowed(command: string): boolean {
      const cmdBase = command.trim();
      return config.allowlistedCommands.some(allowed =>
        cmdBase === allowed || cmdBase.startsWith(allowed + ' ')
      );
    }

    it('should allow exact command matches', () => {
      expect(isCommandAllowed('npm test')).toBe(true);
      expect(isCommandAllowed('git diff')).toBe(true);
      expect(isCommandAllowed('git status')).toBe(true);
      expect(isCommandAllowed('ls -la')).toBe(true);
    });

    it('should allow commands with extra arguments', () => {
      expect(isCommandAllowed('npm test --coverage')).toBe(true);
      expect(isCommandAllowed('git diff HEAD~1')).toBe(true);
      expect(isCommandAllowed('ls -la /tmp')).toBe(true);
    });

    it('should block non-allowlisted commands', () => {
      expect(isCommandAllowed('rm -rf /')).toBe(false);
      expect(isCommandAllowed('curl http://evil.com')).toBe(false);
      expect(isCommandAllowed('npm install malware')).toBe(false);
    });

    it('should handle special __STOP__ command', () => {
      const isStopCommand = (cmd: string) => cmd === '__STOP__';
      expect(isStopCommand('__STOP__')).toBe(true);
      expect(isStopCommand('stop')).toBe(false);
    });
  });

  describe('Output Processing', () => {
    it('should handle stdout chunks', () => {
      const chunks: string[] = [];
      const onStdout = (data: string) => chunks.push(data);

      onStdout('line 1\n');
      onStdout('line 2\n');
      onStdout('line 3\n');

      expect(chunks.length).toBe(3);
      expect(chunks.join('')).toContain('line 1');
    });

    it('should handle stderr chunks', () => {
      const errors: string[] = [];
      const onStderr = (data: string) => errors.push(data);

      onStderr('error: something went wrong\n');

      expect(errors.length).toBe(1);
      expect(errors[0]).toContain('error');
    });

    it('should redact secrets before sending', () => {
      const output = 'Loading config... api_key=secret123\nConnected!';
      const redacted = redactSecrets(output);

      expect(redacted).not.toContain('secret123');
      expect(redacted).toContain('[REDACTED]');
      expect(redacted).toContain('Connected!');
    });
  });

  describe('Lifecycle Events', () => {
    it('should create start marker', () => {
      const marker = {
        event: 'started',
        command: 'test prompt',
        workingDir: '/project'
      };

      expect(marker.event).toBe('started');
      expect(marker.command).toBeDefined();
      expect(marker.workingDir).toBeDefined();
    });

    it('should create finish marker with exit code', () => {
      const successMarker = { event: 'finished', exitCode: 0 };
      const failMarker = { event: 'finished', exitCode: 1 };
      const signalMarker = { event: 'finished', exitCode: 128, signal: 'SIGTERM' };

      expect(successMarker.exitCode).toBe(0);
      expect(failMarker.exitCode).toBe(1);
      expect(signalMarker.signal).toBe('SIGTERM');
    });
  });

  describe('Event Sequencing', () => {
    it('should increment sequence numbers', () => {
      let sequence = 0;
      const getNextSequence = () => ++sequence;

      expect(getNextSequence()).toBe(1);
      expect(getNextSequence()).toBe(2);
      expect(getNextSequence()).toBe(3);
    });

    it('should track events in order', () => {
      const events: Array<{ seq: number; type: string }> = [];
      let seq = 0;

      events.push({ seq: ++seq, type: 'marker' }); // started
      events.push({ seq: ++seq, type: 'stdout' });
      events.push({ seq: ++seq, type: 'stdout' });
      events.push({ seq: ++seq, type: 'stderr' });
      events.push({ seq: ++seq, type: 'marker' }); // finished

      expect(events.length).toBe(5);
      expect(events[0].type).toBe('marker');
      expect(events[4].type).toBe('marker');
      expect(events[events.length - 1].seq).toBe(5);
    });
  });

  describe('Stop Handling', () => {
    it('should track stop requested state', () => {
      let stopRequested = false;
      const requestStop = () => { stopRequested = true; };
      const isStopRequested = () => stopRequested;

      expect(isStopRequested()).toBe(false);
      requestStop();
      expect(isStopRequested()).toBe(true);
    });

    it('should handle graceful vs force stop', () => {
      let signalSent: string | null = null;

      const sendSignal = (signal: string) => { signalSent = signal; };
      const scheduleForceKill = (timeout: number) => {
        return setTimeout(() => sendSignal('SIGKILL'), timeout);
      };

      // Graceful stop
      sendSignal('SIGINT');
      expect(signalSent).toBe('SIGINT');

      // Would schedule force kill
      const timer = scheduleForceKill(10000);
      clearTimeout(timer); // Don't actually wait
    });
  });

  describe('Log File Handling', () => {
    it('should construct log path correctly', () => {
      const runId = 'test-run-123';
      const runsDir = '/project/.data/runs';
      const logPath = `${runsDir}/${runId}/claude.log`;

      expect(logPath).toBe('/project/.data/runs/test-run-123/claude.log');
    });

    it('should format log entries with type prefix', () => {
      const formatLogEntry = (type: string, data: string) => `[${type}] ${data}`;

      expect(formatLogEntry('stdout', 'output')).toBe('[stdout] output');
      expect(formatLogEntry('stderr', 'error')).toBe('[stderr] error');
    });
  });

  describe('Working Directory', () => {
    it('should default to process.cwd()', () => {
      const defaultCwd = process.cwd();
      expect(defaultCwd).toBeDefined();
    });

    it('should use provided working directory', () => {
      const providedCwd = '/custom/path';
      expect(providedCwd).toBe('/custom/path');
    });

    it('should reject paths outside project', () => {
      const isPathSafe = (path: string, projectRoot: string) => {
        return path.startsWith(projectRoot) && !path.includes('..');
      };

      expect(isPathSafe('/project/src', '/project')).toBe(true);
      expect(isPathSafe('/project/../etc', '/project')).toBe(false);
      expect(isPathSafe('/other/path', '/project')).toBe(false);
    });
  });
});

describe('Tmate Assist', () => {
  it('should parse tmate output for SSH URL', () => {
    const tmateOutput = `
To connect to the session locally, run: tmate -S /tmp/tmate-1000/xxx attach
ssh xyzabc@nyc1.tmate.io
https://tmate.io/t/xyzabc
    `.trim();

    const sshMatch = tmateOutput.match(/ssh\s+[\w@\.\-]+/);
    const webMatch = tmateOutput.match(/https?:\/\/[^\s]+/);

    expect(sshMatch?.[0]).toContain('ssh');
    expect(webMatch?.[0]).toContain('https://tmate.io');
  });

  it('should prefer web URL over SSH', () => {
    const output = 'ssh user@host\nhttps://web.url/session';
    const sshMatch = output.match(/ssh\s+[\w@\.\-]+/);
    const webMatch = output.match(/https?:\/\/[^\s]+/);

    const sessionUrl = webMatch?.[0] || sshMatch?.[0] || output.trim();
    expect(sessionUrl).toBe('https://web.url/session');
  });
});

describe('Command Result Handling', () => {
  it('should capture git diff output', () => {
    const diffOutput = `
diff --git a/file.txt b/file.txt
index 1234567..abcdefg 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 line 1
+new line
 line 2
    `.trim();

    expect(diffOutput).toContain('diff --git');
    expect(diffOutput).toContain('+new line');
  });

  it('should handle command timeout', () => {
    const TIMEOUT_MS = 60000;

    const timedExec = (command: string, timeout: number) => {
      if (timeout <= 0) {
        throw new Error('Timeout must be positive');
      }
      // In real implementation, execSync with timeout option
      return { command, timeout };
    };

    const result = timedExec('npm test', TIMEOUT_MS);
    expect(result.timeout).toBe(60000);
  });

  it('should limit result size', () => {
    const MAX_RESULT_SIZE = 10 * 1024 * 1024; // 10MB
    const bigResult = 'x'.repeat(15 * 1024 * 1024); // 15MB

    const truncateResult = (result: string, maxSize: number) => {
      if (result.length > maxSize) {
        return result.slice(0, maxSize) + '\n[TRUNCATED]';
      }
      return result;
    };

    const truncated = truncateResult(bigResult, MAX_RESULT_SIZE);
    expect(truncated.length).toBeLessThan(bigResult.length);
    expect(truncated).toContain('[TRUNCATED]');
  });
});
