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
  TWITCH_REDIRECT_URI: z.string().url().optional(),

  GOOGLE_SHEET_ID: z.string().min(1),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().min(1),
  GOOGLE_SHEET_TAB_NAME: z.string().min(1).default('Games'),

  // Optional hardening
  ADMIN_API_KEY: z.string().min(1).optional(),
  TOKEN_ENCRYPTION_KEY: z.string().min(1).optional()
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
    const stripped = stripWrappingQuotes(v);
    // Treat empty strings as "unset" so optional vars from docker-compose (VAR:-) don't fail validation.
    if (stripped.trim() === '') continue;
    cleaned[k] = stripped;
  }
  return EnvSchema.parse(cleaned);
}

