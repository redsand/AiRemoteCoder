/**
 * Orchestrator service — watches for prompt_waiting events and decides
 * whether to auto-answer or escalate to the user.
 *
 * When enabled for a run, it:
 *  1. Receives the question the AI agent is asking
 *  2. Fetches recent run context (last N events)
 *  3. Calls the configured LLM to classify: auto-answer vs. escalate
 *  4. If auto-answering: POSTs input back to the run and logs the decision
 *  5. If escalating: does nothing — the existing UI prompt-waiting banner handles it
 *
 * Provider config (env vars):
 *  ORCHESTRATOR_PROVIDER      — "ollama" (default) | "anthropic" | "zencoder"
 *  ORCHESTRATOR_MODEL         — model name (default "glm-5:cloud" for ollama)
 *  OLLAMA_HOST                — Ollama base URL (default "http://localhost:11434")
 *  ZENCODER_ACCESS_CODE       — Zencoder access code
 *  ZENCODER_SECRET_KEY        — Zencoder secret key
 */

import { db } from './database.js';
import { broadcastToRun } from './websocket.js';
import { nanoid } from 'nanoid';

// ─── Provider config ──────────────────────────────────────────────────────────

export type OrchestratorProvider = 'ollama' | 'anthropic' | 'zencoder';

function getOrchestratorProvider(): OrchestratorProvider {
  const v = (process.env.ORCHESTRATOR_PROVIDER ?? 'ollama').toLowerCase();
  if (v === 'anthropic') return 'anthropic';
  if (v === 'zencoder') return 'zencoder';
  return 'ollama';
}

function defaultModelForProvider(provider: OrchestratorProvider): string {
  if (provider === 'anthropic') return 'claude-haiku-4-5-20251001';
  if (provider === 'zencoder') return 'gpt-4o-mini'; // Zencoder default
  return 'glm-5:cloud';
}

function getOrchestratorModel(): string {
  return process.env.ORCHESTRATOR_MODEL || defaultModelForProvider(getOrchestratorProvider());
}

function getOllamaHost(): string {
  return (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '');
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

const DECISION_PROMPT = `You are an AI run monitor. An AI coding agent has paused and is waiting for input.

Your job: decide if this is safe to auto-answer, or if it needs the user's attention.

Auto-answer ONLY when the question is:
- A simple yes/no confirmation for a non-destructive action (e.g. "Continue? [y/N]", "Install package? [y/N]")
- A standard "press enter to continue" gate
- A prompt you can answer with high confidence without knowing the codebase

ESCALATE when:
- The question involves deleting, overwriting, or irreversible changes
- The question requires project-specific knowledge
- The intent is ambiguous
- You're not confident (< 0.85)

Respond with ONLY valid JSON — no markdown, no explanation outside the JSON:
{"action":"auto_answer"|"escalate","answer":"y"|"n"|""|null,"confidence":0.0-1.0,"reasoning":"one sentence"}`;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrchestratorDecision {
  runId: string;
  promptText: string;
  action: 'auto_answer' | 'escalate';
  answer: string | null;
  confidence: number;
  reasoning: string;
  decidedAt: number;
  provider: OrchestratorProvider;
  model: string;
}

export interface OrchestratorSettings {
  enabled: boolean;
  provider: OrchestratorProvider;
  model: string;
  ollamaHost: string;
  // Per-run API keys (override env vars; set by the user who configured this run)
  anthropicApiKey?: string;
  zencoderAccessCode?: string;
  zencoderSecretKey?: string;
}

// ─── Per-run enable/disable ───────────────────────────────────────────────────

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/** Returns current orchestrator settings for a run */
export function getOrchestratorSettings(runId: string): OrchestratorSettings {
  const run = db.prepare('SELECT metadata FROM runs WHERE id = ?').get(runId) as { metadata: string | null } | undefined;
  const meta = parseMeta(run?.metadata ?? null);
  const provider = (meta.orchestratorProvider as OrchestratorProvider | undefined) ?? getOrchestratorProvider();
  return {
    enabled: meta.orchestratorEnabled === true,
    provider,
    model: (meta.orchestratorModel as string | undefined) ?? defaultModelForProvider(provider),
    ollamaHost: (meta.orchestratorOllamaHost as string | undefined) ?? getOllamaHost(),
    anthropicApiKey: (meta.orchestratorAnthropicApiKey as string | undefined) ?? undefined,
    zencoderAccessCode: (meta.orchestratorZencoderAccessCode as string | undefined) ?? undefined,
    zencoderSecretKey: (meta.orchestratorZencoderSecretKey as string | undefined) ?? undefined,
  };
}

/** Returns true if orchestrator is enabled for this run */
export function isOrchestratorEnabled(runId: string): boolean {
  return getOrchestratorSettings(runId).enabled;
}

/** Enable or disable orchestrator for a run, with optional model/provider overrides */
export function setOrchestratorSettings(runId: string, settings: Partial<OrchestratorSettings>): void {
  const run = db.prepare('SELECT metadata FROM runs WHERE id = ?').get(runId) as { metadata: string | null } | undefined;
  if (!run) return;
  const meta = parseMeta(run.metadata);
  if ('enabled' in settings) meta.orchestratorEnabled = settings.enabled;
  if ('provider' in settings) meta.orchestratorProvider = settings.provider;
  if ('model' in settings) meta.orchestratorModel = settings.model;
  if ('ollamaHost' in settings) meta.orchestratorOllamaHost = settings.ollamaHost;
  if ('anthropicApiKey' in settings) meta.orchestratorAnthropicApiKey = settings.anthropicApiKey || null;
  if ('zencoderAccessCode' in settings) meta.orchestratorZencoderAccessCode = settings.zencoderAccessCode || null;
  if ('zencoderSecretKey' in settings) meta.orchestratorZencoderSecretKey = settings.zencoderSecretKey || null;
  db.prepare('UPDATE runs SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), runId);
}

// ─── Context builder ──────────────────────────────────────────────────────────

function getRunContext(runId: string): string {
  const events = db.prepare(`
    SELECT type, data FROM events
    WHERE run_id = ? AND type IN ('stdout','stderr','info','marker')
    ORDER BY id DESC LIMIT 20
  `).all(runId) as { type: string; data: string }[];

  return events
    .reverse()
    .map(e => {
      if (e.type === 'info') {
        try {
          const p = JSON.parse(e.data);
          const text = p?.params?.item?.content?.[0]?.text || p?.params?.item?.output || '';
          return text ? `[agent] ${text.slice(0, 200)}` : null;
        } catch { return null; }
      }
      return e.data?.trim() ? `[${e.type}] ${e.data.trim().slice(0, 200)}` : null;
    })
    .filter(Boolean)
    .join('\n');
}

// ─── LLM callers ─────────────────────────────────────────────────────────────

async function callOllama(host: string, model: string, userMessage: string): Promise<string> {
  const response = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: DECISION_PROMPT },
        { role: 'user', content: userMessage },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}`);
  const data = await response.json() as { message?: { content?: string } };
  return data.message?.content ?? '';
}

async function callAnthropic(apiKey: string, model: string, userMessage: string): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      system: DECISION_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Anthropic ${response.status}`);
  const data = await response.json() as { content: Array<{ type: string; text: string }> };
  return data.content?.find(c => c.type === 'text')?.text ?? '';
}

async function callZencoder(accessCode: string, secretKey: string, model: string, userMessage: string): Promise<string> {
  // Zencoder uses OpenAI-compatible chat completions API
  const response = await fetch('https://api.zencoder.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'X-Access-Code': accessCode,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      messages: [
        { role: 'system', content: DECISION_PROMPT },
        { role: 'user', content: userMessage },
      ],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Zencoder ${response.status}`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? '';
}

// ─── Decision recorder ────────────────────────────────────────────────────────

function recordDecision(runId: string, decision: OrchestratorDecision): void {
  const data = JSON.stringify({
    method: 'orchestrator/decision',
    params: decision,
  });
  const result = db.prepare(`
    INSERT INTO events (run_id, type, data, sequence)
    VALUES (?, 'info', ?, 0)
  `).run(runId, data);

  broadcastToRun(runId, {
    type: 'event',
    eventId: Number(result.lastInsertRowid),
    eventType: 'info',
    data,
    timestamp: decision.decidedAt,
  });
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Call this when a prompt_waiting event arrives for a run.
 * Runs asynchronously; never throws.
 */
export async function handlePromptWaiting(runId: string, promptText: string): Promise<void> {
  const settings = getOrchestratorSettings(runId);
  if (!settings.enabled) return;

  try {
    const context = getRunContext(runId);
    const userMessage = [
      context ? `Recent run output:\n${context}\n` : '',
      `The agent is now asking:\n${promptText.slice(0, 1000)}`,
    ].filter(Boolean).join('\n');

    let text: string;

    if (settings.provider === 'anthropic') {
      const apiKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return;
      text = await callAnthropic(apiKey, settings.model, userMessage);
    } else if (settings.provider === 'zencoder') {
      const accessCode = settings.zencoderAccessCode || process.env.ZENCODER_ACCESS_CODE;
      const secretKey = settings.zencoderSecretKey || process.env.ZENCODER_SECRET_KEY;
      if (!accessCode || !secretKey) return;
      text = await callZencoder(accessCode, secretKey, settings.model, userMessage);
    } else {
      text = await callOllama(settings.ollamaHost, settings.model, userMessage);
    }

    // Strip markdown code fences if the model wrapped the JSON
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let parsed: { action: string; answer: string | null; confidence: number; reasoning: string };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return; // Bad response — don't act
    }

    const decision: OrchestratorDecision = {
      runId,
      promptText: promptText.slice(0, 500),
      action: parsed.action === 'auto_answer' ? 'auto_answer' : 'escalate',
      answer: parsed.answer ?? null,
      confidence: Number(parsed.confidence) || 0,
      reasoning: String(parsed.reasoning || ''),
      decidedAt: Math.floor(Date.now() / 1000),
      provider: settings.provider,
      model: settings.model,
    };

    recordDecision(runId, decision);

    if (decision.action === 'auto_answer' && decision.answer && decision.confidence >= 0.85) {
      const input = decision.answer + '\n';
      const id = nanoid(12);
      db.prepare(`
        INSERT INTO commands (id, run_id, command, arguments, status, created_at)
        VALUES (?, ?, '__INPUT__', ?, 'pending', unixepoch())
      `).run(id, runId, input);

      broadcastToRun(runId, { type: 'input_sent', commandId: id, escape: false, source: 'orchestrator' });
    }
  } catch {
    // Never crash the gateway over an orchestrator failure
  }
}
