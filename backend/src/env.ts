import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  DATABASE_URL: z.string().min(1),

  TWITCH_CLIENT_ID: z.string().min(1),
  TWITCH_CLIENT_SECRET: z.string().min(1),
  TWITCH_BROADCASTER_LOGIN: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url().min(1),

  GOOGLE_SHEET_ID: z.string().min(1),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().min(1),
  GOOGLE_SHEET_TAB_NAME: z.string().min(1).default('Games')
});

export type Env = z.infer<typeof EnvSchema>;

function stripWrappingQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
      return v.slice(1, -1);
    }
  }
  return v;
}

export function getEnv(): Env {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    cleaned[k] = stripWrappingQuotes(v);
  }
  return EnvSchema.parse(cleaned);
}

