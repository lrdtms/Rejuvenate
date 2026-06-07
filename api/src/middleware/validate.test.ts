/**
 * Integration-style checks for the `validate()` middleware factory (plan.md Phase 2
 * step 4), exercised through the real `createApp()` + the `mountForTesting` seam
 * (see `app.test.ts` for the established pattern) with throwaway probe routes and
 * tiny Zod schemas — what we actually care about is "does a request through the real
 * middleware chain end up with parsed `req.body`/`params`/`query` and the agreed
 * `{ error: { code: 'VALIDATION_ERROR', message, fields } }` shape on failure", which
 * is an integration concern (it depends on the central error handler in `app.ts`
 * correctly translating the thrown `AppError`).
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp } from '../app';
import { validate } from './validate';

const bodySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  age: z.coerce.number().int().min(0, 'Age must be at least 0').max(120, 'Age must be at most 120'),
});

const paramsSchema = z.object({
  id: z.coerce.number().int().positive('id must be a positive integer'),
});

const querySchema = z.object({
  // `z.coerce.number().default(20)` — proves successful parsing replaces `req.query`
  // with the *parsed/defaulted* result, not the raw string-only query object.
  limit: z.coerce.number().int().positive().max(100).default(20),
});

function buildProbeApp() {
  return createApp({
    mountForTesting: (router) => {
      router.post('/__test/validate/body', validate({ body: bodySchema }), (req, res) => {
        res.json({ body: req.body });
      });

      router.get(
        '/__test/validate/params/:id',
        validate({ params: paramsSchema }),
        (req, res) => {
          res.json({ params: req.params });
        },
      );

      router.get('/__test/validate/query', validate({ query: querySchema }), (req, res) => {
        res.json({ query: req.query });
      });

      router.post(
        '/__test/validate/multi/:id',
        validate({ params: paramsSchema, body: bodySchema, query: querySchema }),
        (req, res) => {
          res.json({ params: req.params, body: req.body, query: req.query });
        },
      );
    },
  });
}

describe('validate() middleware', () => {
  describe('on success', () => {
    it('passes through and replaces req.body with the parsed/coerced data', async () => {
      const app = buildProbeApp();

      const res = await request(app)
        .post('/api/v1/__test/validate/body')
        .send({ name: 'Thandi', age: '34' }); // string age — proves coercion ran

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ body: { name: 'Thandi', age: 34 } });
    });

    it('passes through and replaces req.params with the parsed/coerced data', async () => {
      const app = buildProbeApp();

      const res = await request(app).get('/api/v1/__test/validate/params/42');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ params: { id: 42 } });
    });

    it('passes through and replaces req.query with the parsed/defaulted data', async () => {
      const app = buildProbeApp();

      const res = await request(app).get('/api/v1/__test/validate/query');

      expect(res.status).toBe(200);
      // No `?limit=` supplied — the schema's `.default(20)` must reach the handler,
      // proving `req.query` was replaced with the *parsed* result, not the raw
      // (empty) query object.
      expect(res.body).toEqual({ query: { limit: 20 } });
    });
  });

  describe('on a single-part failure', () => {
    it('responds 400 VALIDATION_ERROR with a fields map keyed by field name (body)', async () => {
      const app = buildProbeApp();

      const res = await request(app)
        .post('/api/v1/__test/validate/body')
        .send({ name: '', age: 200 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe('Validation failed');
      expect(res.body.error.fields).toEqual({
        name: ['Name is required'],
        age: ['Age must be at most 120'],
      });
    });

    it('responds 400 VALIDATION_ERROR for a failing params schema', async () => {
      const app = buildProbeApp();

      const res = await request(app).get('/api/v1/__test/validate/params/not-a-number');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.fields).toEqual({
        id: expect.arrayContaining([expect.any(String)]),
      });
    });

    it('responds 400 VALIDATION_ERROR for a failing query schema', async () => {
      const app = buildProbeApp();

      const res = await request(app).get('/api/v1/__test/validate/query').query({ limit: '0' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(Object.keys(res.body.error.fields)).toEqual(['limit']);
    });

    it('aggregates multiple issues for the same field into one array', async () => {
      const multiIssueSchema = z.object({
        password: z
          .string()
          .min(8, 'Password must be at least 8 characters')
          .regex(/[0-9]/, 'Password must contain a digit'),
      });

      const probeApp = createApp({
        mountForTesting: (router) => {
          router.post('/__test/validate/multi-issue', validate({ body: multiIssueSchema }), (req, res) => {
            res.json({ body: req.body });
          });
        },
      });

      const res = await request(probeApp)
        .post('/api/v1/__test/validate/multi-issue')
        .send({ password: 'short' });

      expect(res.status).toBe(400);
      expect(res.body.error.fields.password).toEqual(
        expect.arrayContaining([
          'Password must be at least 8 characters',
          'Password must contain a digit',
        ]),
      );
      expect(res.body.error.fields.password).toHaveLength(2);
    });
  });

  describe('on a multi-part failure (aggregation)', () => {
    it('merges fields from params, body, AND query into a single VALIDATION_ERROR response', async () => {
      const app = buildProbeApp();

      const res = await request(app)
        .post('/api/v1/__test/validate/multi/not-a-number')
        .query({ limit: '0' })
        .send({ name: '', age: 'not-a-number' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');

      const fields = res.body.error.fields;
      // One field key per failing part, all present in a single response — proves
      // aggregation rather than short-circuiting on the first failing part.
      expect(Object.keys(fields).sort()).toEqual(['age', 'id', 'limit', 'name']);
      expect(fields.id[0]).toEqual(expect.any(String));
      expect(fields.name).toEqual(['Name is required']);
      expect(fields.age[0]).toEqual(expect.any(String));
      expect(fields.limit[0]).toEqual(expect.any(String));
    });
  });
});
