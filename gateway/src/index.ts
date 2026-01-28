import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

import { config, validateConfig } from './config.js';
import { db } from './services/database.js';
import { setupWebSocket, getConnectionStats } from './services/websocket.js';
import { runsRoutes } from './routes/runs.js';
import { artifactRoutes } from './routes/artifacts.js';
import { authRoutes } from './routes/auth.js';
import { rawBodyPlugin } from './middleware/auth.js';

// Validate configuration
validateConfig();

// Ensure data directories exist
for (const dir of [config.dataDir, config.artifactsDir, config.runsDir, config.certsDir]) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// Build HTTPS options if TLS enabled
let httpsOptions: { key: Buffer; cert: Buffer } | undefined;
if (config.tlsEnabled) {
  if (existsSync(config.tlsCert) && existsSync(config.tlsKey)) {
    httpsOptions = {
      key: readFileSync(config.tlsKey),
      cert: readFileSync(config.tlsCert)
    };
    console.log('TLS enabled with certificates from .data/certs/');
  } else {
    console.warn('TLS certificates not found. Run scripts/dev-cert.sh to generate them.');
    console.warn('Starting in HTTP mode (not recommended for production).');
  }
}

// Create Fastify instance
const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname'
      }
    }
  },
  ...(httpsOptions ? { https: httpsOptions } : {}),
  bodyLimit: config.maxBodySize,
  trustProxy: true
});

// Register plugins
await fastify.register(fastifyCors, {
  origin: true, // Configure properly for production
  credentials: true
});

await fastify.register(fastifyHelmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", 'wss:', 'ws:']
    }
  }
});

await fastify.register(fastifyRateLimit, {
  max: config.rateLimit.max,
  timeWindow: config.rateLimit.timeWindow,
  keyGenerator: (request) => {
    // Use CF header if behind Cloudflare
    return request.headers['cf-connecting-ip'] as string ||
           request.headers['x-forwarded-for'] as string ||
           request.ip;
  }
});

await fastify.register(fastifyMultipart, {
  limits: {
    fileSize: config.maxArtifactSize
  }
});

// Cookie support for sessions
await fastify.register(fastifyCookie as any, {
  secret: config.authSecret
});

// Serve UI static files if they exist
const uiDistPath = join(config.projectRoot, 'ui', 'dist');
if (existsSync(uiDistPath)) {
  await fastify.register(fastifyStatic, {
    root: uiDistPath,
    prefix: '/'
  });

  // SPA fallback
  fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });
}

// WebSocket support
await fastify.register(fastifyWebsocket, {
  options: {
    maxPayload: 1024 * 1024, // 1MB
    clientTracking: true
  }
});

// Raw body capture for signature verification
rawBodyPlugin(fastify);

// Setup WebSocket handler
setupWebSocket(fastify);

// Register routes
await fastify.register(runsRoutes);
await fastify.register(artifactRoutes);
await fastify.register(authRoutes);

// Health check
fastify.get('/api/health', async () => {
  const stats = getConnectionStats();
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    connections: stats
  };
});

// Graceful shutdown
const shutdown = async () => {
  console.log('Shutting down...');
  await fastify.close();
  db.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start server
try {
  const address = await fastify.listen({
    port: config.port,
    host: config.host
  });
  console.log(`Gateway server listening at ${address}`);
  console.log(`WebSocket available at ${address.replace('http', 'ws')}/ws`);

  if (!httpsOptions) {
    console.warn('\n⚠️  Running without TLS. Generate certificates with: npm run dev:cert\n');
  }
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
