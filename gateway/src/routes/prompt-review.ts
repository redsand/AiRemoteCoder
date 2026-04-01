import type { FastifyInstance } from 'fastify';
import { uiAuth, requireRole } from '../middleware/auth.js';

const SYSTEM_PROMPT = `You are a prompt engineering expert helping improve AI coding assistant prompts.
The user is sending instructions to an AI coding agent. Review their prompt and return an improved version that is:
- Clearer and more specific about the goal
- More actionable with explicit success criteria where missing
- Better structured (break down complex tasks if needed)
- Free of ambiguity that could lead the AI in the wrong direction

Return ONLY a JSON object with no markdown or extra text:
{"improved": "the improved prompt text", "reasoning": "1-2 sentences on the key changes made"}`;

export async function promptReviewRoutes(fastify: FastifyInstance) {
  fastify.post('/api/prompt-review', {
    preHandler: [uiAuth, requireRole('admin', 'operator')],
    handler: async (request, reply) => {
      const { prompt } = request.body as { prompt: string };

      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        return reply.code(400).send({ error: 'prompt is required' });
      }

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return reply.code(503).send({ error: 'ANTHROPIC_API_KEY not configured' });
      }

      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 2048,
            system: SYSTEM_PROMPT,
            messages: [
              { role: 'user', content: `Review and improve this prompt:\n\n${prompt.trim()}` }
            ],
          }),
          signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
          const err = await response.text();
          fastify.log.warn(`Claude API error during prompt review: ${err}`);
          return reply.code(502).send({ error: 'AI review service unavailable' });
        }

        const data = await response.json() as {
          content: Array<{ type: string; text: string }>;
        };

        const text = data.content?.find(c => c.type === 'text')?.text ?? '';
        let parsed: { improved: string; reasoning: string };
        try {
          parsed = JSON.parse(text);
        } catch {
          // If Claude didn't return clean JSON, use the raw text as the improved version
          parsed = { improved: text.trim(), reasoning: 'Prompt was refined for clarity.' };
        }

        return reply.send({
          original: prompt.trim(),
          improved: parsed.improved ?? prompt.trim(),
          reasoning: parsed.reasoning ?? '',
        });
      } catch (err) {
        fastify.log.error(err, 'prompt-review error');
        return reply.code(500).send({ error: 'Failed to review prompt' });
      }
    },
  });
}
