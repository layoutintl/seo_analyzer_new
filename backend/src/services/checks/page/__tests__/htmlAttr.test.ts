/**
 * htmlAttr.test.ts
 *
 * Unit tests for the shared getAttrValue() and walkLinkTags() helpers.
 * These helpers underpin canonical, hreflang, AMP-link, and pagination checks.
 */

import { describe, it, expect } from 'vitest';
import { getAttrValue, walkLinkTags } from '../htmlAttr.js';

// ── getAttrValue ────────────────────────────────────────────────────────────

describe('getAttrValue — quoting styles', () => {
  it('reads a double-quoted value', () => {
    expect(getAttrValue('rel="canonical"', 'rel')).toBe('canonical');
  });

  it('reads a single-quoted value', () => {
    expect(getAttrValue("rel='canonical'", 'rel')).toBe('canonical');
  });

  it('reads an unquoted value', () => {
    expect(getAttrValue('rel=canonical', 'rel')).toBe('canonical');
  });

  it('reads an unquoted value when mixed with other attrs', () => {
    expect(getAttrValue(' href="https://example.com/" rel=canonical', 'rel')).toBe('canonical');
  });

  it('reads a double-quoted href', () => {
    expect(getAttrValue(' rel="canonical" href="https://example.com/"', 'href')).toBe('https://example.com/');
  });

  it('returns null when attribute is absent', () => {
    expect(getAttrValue('rel="canonical"', 'href')).toBeNull();
  });

  it('returns null for empty double-quoted value', () => {
    expect(getAttrValue('href=""', 'href')).toBeNull();
  });

  it('returns null for empty single-quoted value', () => {
    expect(getAttrValue("href=''", 'href')).toBeNull();
  });
});

describe('getAttrValue — case insensitivity', () => {
  it('matches uppercase attribute name', () => {
    expect(getAttrValue('REL="canonical"', 'rel')).toBe('canonical');
  });

  it('matches mixed-case attribute name', () => {
    expect(getAttrValue('Href="https://example.com/"', 'href')).toBe('https://example.com/');
  });
});

describe('getAttrValue — whitespace', () => {
  it('handles spaces around = sign', () => {
    expect(getAttrValue('rel = "canonical"', 'rel')).toBe('canonical');
  });

  it('trims leading/trailing whitespace from unquoted value', () => {
    // Unquoted stops at whitespace so there's nothing to strip, but the .trim() is there for safety
    expect(getAttrValue('  rel=canonical  href="x"', 'rel')).toBe('canonical');
  });
});

// ── walkLinkTags ────────────────────────────────────────────────────────────

describe('walkLinkTags — visitation', () => {
  it('visits all link tags', () => {
    const html = '<link rel="a"><link rel="b"><link rel="c">';
    const rels: string[] = [];
    walkLinkTags(html, (attrs) => { rels.push(getAttrValue(attrs, 'rel') ?? ''); });
    expect(rels).toEqual(['a', 'b', 'c']);
  });

  it('stops early when visitor returns false', () => {
    const html = '<link rel="a"><link rel="b"><link rel="c">';
    const rels: string[] = [];
    walkLinkTags(html, (attrs) => {
      const r = getAttrValue(attrs, 'rel') ?? '';
      rels.push(r);
      if (r === 'b') return false;
    });
    expect(rels).toEqual(['a', 'b']); // 'c' is never visited
  });

  it('handles self-closing tags', () => {
    const html = '<link rel="canonical" href="https://example.com/" />';
    const hrefs: string[] = [];
    walkLinkTags(html, (attrs) => { hrefs.push(getAttrValue(attrs, 'href') ?? ''); });
    expect(hrefs).toEqual(['https://example.com/']);
  });

  it('handles uppercase <LINK> tags', () => {
    const html = '<LINK REL="canonical" HREF="https://example.com/">';
    const found: string[] = [];
    walkLinkTags(html, (attrs) => { found.push(attrs); });
    expect(found).toHaveLength(1);
    expect(getAttrValue(found[0], 'rel')).toBe('canonical');
  });

  it('visits nothing when there are no link tags', () => {
    const html = '<html><head><title>No links</title></head></html>';
    let count = 0;
    walkLinkTags(html, () => { count++; });
    expect(count).toBe(0);
  });
});
