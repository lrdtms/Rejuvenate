/**
 * Centralized environment configuration.
 *
 * Loads `.env` (via dotenv) and validates the resulting `process.env` shape with Zod
 * so the app fails fast at startup with a clear error if required config is missing —
 * rather than failing confusingly later at first use.
 *
 * NOTE: This is Phase 0 scaffolding — kept intentionally minimal. Modules added in
 * later phases (auth, media, etc.) may extend this schema as new env vars are needed.
 */
import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be set to a long random value'),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().positive().optional().default(587),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  SMTP_FROM: z.string().optional().default(''),
  // Absolute path outside the repo checkout in any deployed environment — see
  // api/.gitignore and deploy/README.md for why this must never live under api/dist.
  UPLOADS_DIR: z.string().min(1).default('./uploads'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment configuration — see errors above.');
  }
  return parsed.data;
}

export const env = loadEnv();
