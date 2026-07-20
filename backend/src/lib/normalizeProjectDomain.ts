/**
 * Project URL / domain normalization.
 *
 * Owns the single definition of "what makes two projects the same project"
 * for the main application. Used by BOTH creation paths:
 *   - POST /api/projects              (manual creation)
 *   - POST /api/technical-analyzer/run (implicit upsert during an audit)
 * so a domain cannot land in `sites` twice depending on how it got there.
 *
 * This file is intentionally self-contained. The runner in ops/seo-audit-runner/
 * has its own copy of these rules — the app must never import from the runner
 * and the runner must never import from the app.
 *
 * The normalized domain is an identity key only. It is never fetched, and it
 * never replaces the URLs the audit engine actually crawls.
 */

/** The only protocols a project website may use. */
export const ALLOWED_PROTOCOLS = ['http:', 'https:'] as const;

export type UrlRejectionReason =
  /** empty / not a string */
  | 'EMPTY'
  /** parsed fine but the scheme is not http/https (javascript:, file:, data:, …) */
  | 'UNSUPPORTED_PROTOCOL'
  /** could not be parsed as a URL at all */
  | 'INVALID';

export type ParsedWebUrl =
  | { ok: true; url: URL }
  | { ok: false; reason: UrlRejectionReason };

export type NormalizedWebsiteUrl =
  | { ok: true; websiteUrl: string; domain: string }
  | { ok: false; reason: UrlRejectionReason };

/** `https://…`, `http://…`, `ftp://…` — a scheme written with the `://` separator. */
const SCHEME_WITH_SLASHES = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * An opaque scheme — `javascript:`, `data:`, `mailto:` — i.e. a colon that is
 * NOT followed by a port number. `example.com:8080` deliberately does not match,
 * so bare host:port input still gets an implicit https:// prefix.
 */
const OPAQUE_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?![0-9])/;

/**
 * Parse user input into a URL, adding `https://` when no scheme was given.
 *
 * Accepts:  example.com · example.com:8080 · http://example.com · https://example.com/a?b=c
 * Rejects:  javascript:alert(1) · data:text/plain · file:///etc/passwd · mailto:a@b.c
 */
export function parseWebUrl(input: unknown): ParsedWebUrl {
  if (typeof input !== 'string') return { ok: false, reason: 'EMPTY' };
  const raw = input.trim();
  if (!raw) return { ok: false, reason: 'EMPTY' };
  if (/\s/.test(raw)) return { ok: false, reason: 'INVALID' };

  let candidate: string;
  if (SCHEME_WITH_SLASHES.test(raw)) {
    candidate = raw;
  } else if (OPAQUE_SCHEME.test(raw)) {
    // A scheme we will never allow — reject it rather than mangling it into a host.
    return { ok: false, reason: 'UNSUPPORTED_PROTOCOL' };
  } else {
    candidate = `https://${raw}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: 'INVALID' };
  }

  if (!(ALLOWED_PROTOCOLS as readonly string[]).includes(url.protocol)) {
    return { ok: false, reason: 'UNSUPPORTED_PROTOCOL' };
  }
  if (!url.hostname) return { ok: false, reason: 'INVALID' };

  return { ok: true, url };
}

/**
 * Reduce a URL (or bare hostname) to the project identity key stored in `sites.domain`.
 *
 * Rules:
 *  - lowercase the hostname
 *  - drop a single trailing dot (FQDN form)
 *  - drop ONE leading `www.` label — `example.com` and `www.example.com` are one project
 *  - keep every other subdomain — `blog.example.com` is a different project
 *  - ignore the default ports 80/443, preserve any other explicit port
 *
 * Returns null when the input is not a usable http/https URL.
 */
export function normalizeProjectDomain(input: unknown): string | null {
  const parsed = parseWebUrl(input);
  if (!parsed.ok) return null;
  const { url } = parsed;

  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;

  if (host.startsWith('www.') && host.length > 'www.'.length) {
    host = host.slice(4);
  }
  if (!host) return null;

  const port = url.port;
  if (port && port !== '80' && port !== '443') return `${host}:${port}`;
  return host;
}

/**
 * Normalize a user-supplied website URL into the pair we persist:
 * the canonical URL (`sites.website_url`) and the identity key (`sites.domain`).
 */
export function normalizeWebsiteUrl(input: unknown): NormalizedWebsiteUrl {
  const parsed = parseWebUrl(input);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const domain = normalizeProjectDomain(parsed.url.href);
  if (!domain) return { ok: false, reason: 'INVALID' };

  return { ok: true, websiteUrl: parsed.url.toString(), domain };
}

/** Human-readable message for a rejected URL, suitable for an API 400 body. */
export function describeUrlRejection(field: string, reason: UrlRejectionReason): string {
  switch (reason) {
    case 'EMPTY':
      return `${field} is required`;
    case 'UNSUPPORTED_PROTOCOL':
      return `Invalid ${field} — only http and https URLs are supported`;
    default:
      return `Invalid ${field}`;
  }
}
