/**
 * Origin guard for provider-supplied URLs.
 *
 * chapterKeys reach `getPages`/`getContent` straight from API callers, so a
 * provider that fetches whatever URL a key carries is an open proxy (SSRF).
 * Resolve the key against the provider's base and accept it only when it stays
 * on that provider's own site.
 */

const siteDomain = (base: string): string => new URL(base).hostname.toLowerCase().replace(/^www\./, '');

/**
 * Resolve `raw` (absolute or relative to the first base) and return its href if
 * it is http(s), carries no credentials, and its host is one of the bases'
 * domains or a subdomain of one (`www.` is ignored, so `https://www.x.com`
 * also admits `x.com` and `cdn.x.com`). Returns null otherwise.
 */
export function providerUrl(raw: string, bases: string | readonly string[]): string | null {
  const list = typeof bases === 'string' ? [bases] : bases;
  if (!raw || list.length === 0) return null;
  let url: URL;
  try {
    url = new URL(raw, list[0]);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const allowed = list.some((base) => {
    const domain = siteDomain(base);
    return host === domain || host.endsWith(`.${domain}`);
  });
  return allowed ? url.href : null;
}

/**
 * Validate a base URL read from a third-party domains manifest (GitHub /
 * Codeberg JSON). Whoever controls that file chooses where the provider
 * scrapes, so only accept an https URL on a named host (no IP literal, port or
 * credentials) whose hostname matches the site's brand — mirror rotation keeps
 * working, arbitrary redirection does not. Returns the URL without a trailing
 * slash, or null to keep the built-in default.
 */
export function mirrorBase(raw: unknown, brand: RegExp): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.includes(':') || /^[\d.]+$/.test(host)) return null;
  if (!brand.test(host)) return null;
  return url.href.replace(/\/$/, '');
}

/**
 * True for hostnames that point at the local machine or a private network:
 * localhost, loopback / RFC 1918 / link-local / CGNAT IPv4 literals, and
 * loopback / unique-local / link-local IPv6 literals. Name-based only (no DNS).
 */
export function isPrivateHost(hostname: string): boolean {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (host.includes(':')) {
    return host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:');
  }
  return false;
}
