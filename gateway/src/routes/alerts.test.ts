import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { alertsRouter } from './alerts.js';

vi.mock('../services/database.js', () => ({
  db: {
    prepare: vi.fn(),
    exec: vi.fn()
  }
}));

describe('alerts router', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/alerts', alertsRouter);
  });

  it('should respond to GET /alerts', async () => {
    const response = await request(app).get('/alerts');
    expect(response.status).toBe(200);
  });

  it('should respond to POST /alerts', async () => {
    const response = await request(app)
      .post('/alerts')
      .send({ message: 'Test alert' });
    expect(response.status).toBe(201);
  });

  it('should respond to GET /alerts/:id', async () => {
    const response = await request(app).get('/alerts/1');
    expect(response.status).toBe(200);
  });

  it('should respond to DELETE /alerts/:id', async () => {
    const response = await request(app).delete('/alerts/1');
    expect(response.status).toBe(204);
  });
});