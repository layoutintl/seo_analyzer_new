/**
 * Domain normalization — used ONLY as a duplicate-comparison key.
 *
 * The normalized value is never used to fetch anything and never replaces
 * the project's stored ID, website URL, or audit URLs.
 *
 * Rules:
 *  - lowercase hostname
 *  - remove scheme, credentials, path, query string, fragment
 *  - remove a single trailing dot
 *  - ignore default ports 80 and 443; preserve non-default ports
 *  - remove ONE leading `www.` label
 *  - all other subdomains stay distinct
 */

export function normalizeDomainKey(input) {
  if (typeof input !== 'string') return null;
  let raw = input.trim();
  if (!raw) return null;

  // Accept bare hostnames ("example.com") by giving them a scheme first.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    raw = `https://${raw}`;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  let host = url.hostname.toLowerCase();
  if (!host) return null;

  // Remove a single trailing dot (FQDN form).
  host = host.replace(/\.$/, '');

  // Remove ONE leading "www." label only.
  if (host.startsWith('www.') && host.length > 'www.'.length) {
    host = host.slice(4);
  }

  // URL already drops the scheme-default port; additionally always ignore
  // 80 and 443, preserve any other explicit port.
  const port = url.port;
  if (port && port !== '80' && port !== '443') {
    return `${host}:${port}`;
  }
  return host;
}
