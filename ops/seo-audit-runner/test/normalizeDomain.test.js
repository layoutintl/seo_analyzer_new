import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomainKey } from '../src/normalizeDomain.js';

test('spec examples', () => {
  assert.equal(normalizeDomainKey('https://www.example.com/path'), 'example.com');
  assert.equal(normalizeDomainKey('http://example.com'), 'example.com');
  assert.equal(normalizeDomainKey('https://blog.example.com'), 'blog.example.com');
  assert.equal(normalizeDomainKey('https://example.com:8443'), 'example.com:8443');
});

test('lowercases the hostname', () => {
  assert.equal(normalizeDomainKey('https://WWW.Example.COM'), 'example.com');
});

test('removes credentials, path, query, and fragment', () => {
  assert.equal(
    normalizeDomainKey('https://user:secret@www.example.com:443/a/b?q=1#frag'),
    'example.com',
  );
});

test('removes a trailing dot', () => {
  assert.equal(normalizeDomainKey('https://www.example.com./x'), 'example.com');
  assert.equal(normalizeDomainKey('https://example.com.'), 'example.com');
});

test('ignores default ports 80 and 443 regardless of scheme', () => {
  assert.equal(normalizeDomainKey('http://example.com:80'), 'example.com');
  assert.equal(normalizeDomainKey('https://example.com:443'), 'example.com');
  assert.equal(normalizeDomainKey('http://example.com:443'), 'example.com');
  assert.equal(normalizeDomainKey('https://example.com:80'), 'example.com');
});

test('preserves non-default ports', () => {
  assert.equal(normalizeDomainKey('http://example.com:8080'), 'example.com:8080');
});

test('removes only ONE leading www label', () => {
  assert.equal(normalizeDomainKey('https://www.www.example.com'), 'www.example.com');
});

test('keeps non-www subdomains distinct', () => {
  assert.notEqual(
    normalizeDomainKey('https://blog.example.com'),
    normalizeDomainKey('https://example.com'),
  );
  assert.notEqual(
    normalizeDomainKey('https://api.example.com'),
    normalizeDomainKey('https://blog.example.com'),
  );
});

test('accepts bare hostnames (project.domain values)', () => {
  assert.equal(normalizeDomainKey('www.example.com'), 'example.com');
  assert.equal(normalizeDomainKey('example.com'), 'example.com');
});

test('www and non-www collapse to the same key', () => {
  assert.equal(
    normalizeDomainKey('https://www.example.com'),
    normalizeDomainKey('http://example.com'),
  );
});

test('invalid input returns null', () => {
  assert.equal(normalizeDomainKey(''), null);
  assert.equal(normalizeDomainKey('   '), null);
  assert.equal(normalizeDomainKey(null), null);
  assert.equal(normalizeDomainKey(undefined), null);
  assert.equal(normalizeDomainKey('ftp://example.com'), null);
  assert.equal(normalizeDomainKey('http://'), null);
});
