import { describe, it, expect } from 'vitest';
import {
  parseWebUrl,
  normalizeProjectDomain,
  normalizeWebsiteUrl,
  describeUrlRejection,
} from '../normalizeProjectDomain.js';

describe('parseWebUrl', () => {
  it('accepts a scheme-less URL by assuming https', () => {
    const r = parseWebUrl('example.com');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.protocol).toBe('https:');
  });

  it('accepts http and https URLs', () => {
    expect(parseWebUrl('http://example.com').ok).toBe(true);
    expect(parseWebUrl('https://example.com/a?b=c').ok).toBe(true);
  });

  it('keeps a scheme-less host:port as a host and a port', () => {
    const r = parseWebUrl('example.com:8080');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url.hostname).toBe('example.com');
      expect(r.url.port).toBe('8080');
    }
  });

  it.each(['javascript:alert(1)', 'data:text/plain,hi', 'file:///etc/passwd', 'mailto:a@b.com'])(
    'rejects the unsupported protocol %s',
    (input) => {
      const r = parseWebUrl(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('UNSUPPORTED_PROTOCOL');
    },
  );

  it('rejects empty and non-string input', () => {
    for (const input of ['', '   ', null, undefined, 42, {}]) {
      const r = parseWebUrl(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('EMPTY');
    }
  });

  it('rejects input containing whitespace', () => {
    const r = parseWebUrl('exa mple.com');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('INVALID');
  });
});

describe('normalizeProjectDomain', () => {
  it('lowercases the hostname', () => {
    expect(normalizeProjectDomain('https://EXAMPLE.COM')).toBe('example.com');
    expect(normalizeProjectDomain('HTTPS://Example.Com/Path')).toBe('example.com');
  });

  it('removes a trailing dot', () => {
    expect(normalizeProjectDomain('https://example.com.')).toBe('example.com');
    expect(normalizeProjectDomain('https://www.example.com.')).toBe('example.com');
  });

  it('treats www and non-www as the same project', () => {
    expect(normalizeProjectDomain('https://www.example.com')).toBe('example.com');
    expect(normalizeProjectDomain('example.com')).toBe('example.com');
    expect(normalizeProjectDomain('http://WWW.Example.com/news')).toBe('example.com');
  });

  it('removes only ONE leading www label', () => {
    expect(normalizeProjectDomain('https://www.www.example.com')).toBe('www.example.com');
  });

  it('keeps other subdomains distinct', () => {
    expect(normalizeProjectDomain('https://blog.example.com')).toBe('blog.example.com');
    expect(normalizeProjectDomain('https://next.al-madina.com')).toBe('next.al-madina.com');
    expect(normalizeProjectDomain('https://blog.example.com')).not.toBe(
      normalizeProjectDomain('https://example.com'),
    );
  });

  it('ignores the default ports and preserves other ports', () => {
    expect(normalizeProjectDomain('http://example.com:80')).toBe('example.com');
    expect(normalizeProjectDomain('https://example.com:443')).toBe('example.com');
    expect(normalizeProjectDomain('http://example.com:8080')).toBe('example.com:8080');
    expect(normalizeProjectDomain('https://www.example.com:8443')).toBe('example.com:8443');
  });

  it('ignores path, query, fragment and credentials', () => {
    expect(normalizeProjectDomain('https://example.com/a/b?c=d#e')).toBe('example.com');
    expect(normalizeProjectDomain('https://user:pass@example.com')).toBe('example.com');
  });

  it('returns null for unusable input', () => {
    expect(normalizeProjectDomain('javascript:alert(1)')).toBeNull();
    expect(normalizeProjectDomain('')).toBeNull();
    expect(normalizeProjectDomain(null)).toBeNull();
  });
});

describe('normalizeWebsiteUrl', () => {
  it('returns a canonical URL and the identity domain', () => {
    const r = normalizeWebsiteUrl('WWW.Example.com');
    expect(r).toEqual({ ok: true, websiteUrl: 'https://www.example.com/', domain: 'example.com' });
  });

  it('preserves the path the user supplied', () => {
    const r = normalizeWebsiteUrl('https://example.com/news');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.websiteUrl).toBe('https://example.com/news');
  });

  it('reports the rejection reason', () => {
    expect(normalizeWebsiteUrl('javascript:alert(1)')).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_PROTOCOL',
    });
  });
});

describe('describeUrlRejection', () => {
  it('produces field-specific messages', () => {
    expect(describeUrlRejection('website_url', 'EMPTY')).toBe('website_url is required');
    expect(describeUrlRejection('website_url', 'UNSUPPORTED_PROTOCOL')).toContain('http and https');
    expect(describeUrlRejection('articleUrl', 'INVALID')).toBe('Invalid articleUrl');
  });
});
