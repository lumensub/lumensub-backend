import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string, pretty = process.env.NODE_ENV === 'development'): Logger {
  return pino({
    level,
    base: { service: 'lumensub-backend' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        '*.secret',
        '*.keeperSecret',
        '*.signingSecret',
      ],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
  });
}
