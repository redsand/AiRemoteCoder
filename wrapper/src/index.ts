/**
 * Claude Code Wrapper - Module Exports
 *
 * This module can be used programmatically to integrate the wrapper
 * into other tools or scripts.
 */

export { ClaudeRunner, type RunnerOptions } from './services/claude-runner.js';
export {
  sendEvent,
  uploadArtifact,
  pollCommands,
  ackCommand,
  testConnection,
  type RunAuth,
  type GatewayEvent,
  type Command
} from './services/gateway-client.js';
export {
  createSignature,
  hashBody,
  generateNonce,
  redactSecrets,
  type SignatureComponents
} from './utils/crypto.js';
export { config, validateConfig } from './config.js';
