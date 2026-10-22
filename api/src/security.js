/**
 * Network exposure defaults for the standalone API server.
 *
 * The server scrapes third-party sites and can launch a headless browser on
 * every request, so by default it is reachable only from this machine and only
 * by local pages:
 *
 *   <PREFIX>_HOST           Bind address. Default 127.0.0.1. Set 0.0.0.0 for a
 *                           hosted / container deployment.
 *   <PREFIX>_CORS_ORIGINS   Comma-separated browser origins allowed to call the
 *                           API, or "*" for any. Loopback origins
 *                           (http://localhost:*, http://127.0.0.1:*) are always
 *                           allowed; requests without an Origin are unaffected.
 *   <PREFIX>_ADMIN_TOKEN    Shared secret for the admin routes (reload, cache
 *                           clear, debug), sent as `X-Admin-Token`. When unset,
 *                           those routes answer loopback clients only.
 */
import { timingSafeEqual } from 'node:crypto';

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_ADDRESS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function createApiSecurity(prefix) {
  const env = (name) => String(process.env[`${prefix}_${name}`] || '').trim();
  const host = env('HOST') || '127.0.0.1';
  const configured = env('CORS_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean);
  const anyOrigin = configured.includes('*');
  const adminToken = env('ADMIN_TOKEN');

  const corsOptions = {
    origin(origin, callback) {
      if (!origin || anyOrigin || LOOPBACK_ORIGIN.test(origin) || configured.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
  };

  /** Express middleware guarding routes that mutate server state or leak internals. */
  function requireAdmin(req, res, next) {
    if (adminToken) {
      const given = Buffer.from(String(req.get('x-admin-token') || ''));
      const expected = Buffer.from(adminToken);
      if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (LOOPBACK_ADDRESS.has(req.socket?.remoteAddress || '')) return next();
    return res.status(403).json({ error: `Forbidden: set ${prefix}_ADMIN_TOKEN to use admin routes remotely` });
  }

  return { host, corsOptions, requireAdmin };
}
