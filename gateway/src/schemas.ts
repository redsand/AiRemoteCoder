/**
 * Zod validation schemas for all API endpoints
 */

import { z } from 'zod';

// =============================================================================
// Runs
// =============================================================================

export const createRunSchema = z.object({
  command: z.string().max(10000).optional(),
  metadata: z.record(z.any()).optional()
});

export const runIdParamSchema = z.object({
  runId: z.string().min(1).max(50)
});

export const eventsQuerySchema = z.object({
  after: z.string().regex(/^\d+$/).optional(),
  limit: z.string().regex(/^\d+$/).optional()
});

// =============================================================================
// Events
// =============================================================================

export const eventSchema = z.object({
  type: z.enum(['stdout', 'stderr', 'marker', 'info', 'error', 'assist']),
  data: z.string().max(1024 * 1024), // 1MB max per event
  sequence: z.number().int().min(0).optional()
});

// =============================================================================
// Commands
// =============================================================================

export const commandSchema = z.object({
  command: z.string().min(1).max(1000)
});

export const commandIdParamSchema = z.object({
  runId: z.string().min(1).max(50),
  commandId: z.string().min(1).max(50)
});

export const commandAckSchema = z.object({
  result: z.string().max(10 * 1024 * 1024).optional(), // 10MB max result
  error: z.string().max(100000).optional()
});

// =============================================================================
// Auth
// =============================================================================

export const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
  totpCode: z.string().length(6).regex(/^\d+$/).optional()
});

export const setupSchema = z.object({
  username: z.string()
    .min(3, 'Username must be at least 3 characters')
    .max(50, 'Username must be at most 50 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, underscores, and hyphens'),
  password: z.string()
    .min(12, 'Password must be at least 12 characters')
    .max(200, 'Password must be at most 200 characters'),
  enableTotp: z.boolean().optional()
});

export const createUserSchema = z.object({
  username: z.string()
    .min(3)
    .max(50)
    .regex(/^[a-zA-Z0-9_-]+$/),
  password: z.string().min(12).max(200),
  role: z.enum(['admin', 'operator', 'viewer'])
});

// =============================================================================
// Artifacts
// =============================================================================

export const artifactIdParamSchema = z.object({
  artifactId: z.string().min(1).max(50)
});

// =============================================================================
// Type exports
// =============================================================================

export type CreateRunInput = z.infer<typeof createRunSchema>;
export type EventInput = z.infer<typeof eventSchema>;
export type CommandInput = z.infer<typeof commandSchema>;
export type CommandAckInput = z.infer<typeof commandAckSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type SetupInput = z.infer<typeof setupSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
