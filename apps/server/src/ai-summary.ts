import Anthropic from '@anthropic-ai/sdk';
import type { ProjectInsights } from '@izaro/shared';
import { config } from './config.js';

const SYSTEM = `You summarise visual regression test results for a QA team. The app under test is checked with screenshots only: steps find controls by image, and each screen is compared with a library of known screens. A run in "review" means a screen or control changed and a person must accept or reject the change; it is not a failure.

Write 3 to 5 short sentences in plain English for a test lead: the overall state, what most needs attention and why, and one concrete next step. Name scenarios in quotes. Do not repeat every number, do not use headings or lists, and do not invent causes the data doesn't show.`;

/** Asks Claude for a short summary of the insights; undefined when no key is configured. */
export async function summarizeInsights(projectName: string, insights: ProjectInsights): Promise<string | undefined> {
  if (!config.claude.apiKey) return undefined;
  const client = new Anthropic({ apiKey: config.claude.apiKey });
  // Only the computed insights are sent: names, statuses, durations and step errors. No screenshots, secrets or keys.
  const { aiAvailable: _, ...data } = insights;
  const response = await client.beta.messages.create({
    model: config.claude.model,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: SYSTEM,
    messages: [{ role: 'user', content: `Project: ${projectName}\n\nInsights (JSON):\n${JSON.stringify(data)}` }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude declined to summarise these results');
  return response.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
}
