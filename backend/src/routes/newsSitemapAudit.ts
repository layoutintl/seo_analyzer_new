/**
 * News Sitemap Audit API — isolated, additive route.
 *
 * Mounts under /api in server/index.js. Stateless: requires no database and
 * never touches audit_runs / audit_results or the existing audit engine. It
 * simply fetches and quality-checks a Google News Sitemap on demand.
 *
 * Endpoint:
 *   POST /api/news-sitemap/audit
 *     body: {
 *       url: string,                       // required — the News Sitemap URL
 *       expectedDomain?: string,           // optional — restrict <loc> host checks
 *       expectedPublicationName?: string,  // optional — <news:name> consistency
 *       maxAgeHours?: number,              // optional — freshness threshold
 *       futureSkewHours?: number           // optional — future-date tolerance
 *     }
 *
 * Designed for both the UI and future scheduled (cron) audits, which can read a
 * project's saved newsSitemapUrl and POST it here without any UI interaction.
 */

import { Router, Request, Response } from 'express';
import { analyzeNewsSitemap } from '../services/newsSitemap/newsSitemapAnalyzer.js';

export const newsSitemapAuditRouter = Router();

newsSitemapAuditRouter.post('/news-sitemap/audit', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const url = typeof body.url === 'string' ? body.url.trim() : '';

  if (!url) {
    res.status(400).json({ error: 'url is required' });
    return;
  }

  const toPosNum = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };

  try {
    const result = await analyzeNewsSitemap(url, {
      expectedDomain:
        typeof body.expectedDomain === 'string' && body.expectedDomain.trim()
          ? body.expectedDomain.trim()
          : undefined,
      expectedPublicationName:
        typeof body.expectedPublicationName === 'string' && body.expectedPublicationName.trim()
          ? body.expectedPublicationName.trim()
          : undefined,
      maxAgeHours: toPosNum(body.maxAgeHours),
      futureSkewHours: toPosNum(body.futureSkewHours),
    });
    res.json({ newsSitemap: result });
  } catch (err) {
    console.error('POST /api/news-sitemap/audit error:', err);
    res.status(500).json({ error: 'Failed to analyze News Sitemap' });
  }
});
