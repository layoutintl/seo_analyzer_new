/**
 * AI Assist API — optional, additive, server-side only.
 *
 * Mounts under /api in server/index.js. This route is the ONLY place the
 * frontend talks to for AI features; the NVIDIA API key never leaves the
 * server. Every endpoint runs AFTER a deterministic audit finding exists and
 * only explains / prioritizes / rewrites copy — it never decides whether an
 * SEO issue exists.
 *
 * Endpoints:
 *   GET  /api/ai/status
 *     → { enabled: boolean }   // lets the UI show/hide AI actions
 *
 *   POST /api/ai/explain
 *     body: { finding, pageContext, language? }
 *
 *   POST /api/ai/recommend
 *     body: { finding, pageContext, language? }
 *
 *   POST /api/ai/rewrite-title
 *     body: { currentTitle, pageContext, targetKeyword?, language? }
 *
 *   POST /api/ai/rewrite-description
 *     body: { currentDescription, pageContext, targetKeyword?, language? }
 *
 * All POST endpoints always respond 200 with a structured JSON body. When AI is
 * disabled or fails, the body is a clean fallback (ai_available:false / error)
 * so the audit UI never breaks.
 */

import { Router, Request, Response } from 'express';
import {
  isAiEnabled,
  generateAuditExplanation,
  generateClientRecommendation,
  rewriteMetaTitle,
  rewriteMetaDescription,
  type PageContext,
} from '../services/ai/nvidiaProvider.js';

export const aiAssistRouter = Router();

/** Coerce arbitrary request input into the bounded PageContext shape. */
function toPageContext(v: unknown): PageContext {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const str = (x: unknown): string | undefined =>
    typeof x === 'string' && x.trim() ? x : undefined;
  return {
    url: str(o.url),
    issueType: str(o.issueType),
    currentTitle: typeof o.currentTitle === 'string' ? o.currentTitle : undefined,
    currentMetaDescription:
      typeof o.currentMetaDescription === 'string' ? o.currentMetaDescription : undefined,
    headingSummary: str(o.headingSummary),
    detectedIssue: o.detectedIssue,
    pageTextExcerpt: str(o.pageTextExcerpt),
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const optStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v : undefined;

aiAssistRouter.get('/ai/status', (_req: Request, res: Response) => {
  res.json({ enabled: isAiEnabled() });
});

aiAssistRouter.post('/ai/explain', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  try {
    const result = await generateAuditExplanation(
      body.finding,
      toPageContext(body.pageContext),
      optStr(body.language),
    );
    res.json(result);
  } catch (err) {
    console.error('POST /api/ai/explain error:', err);
    res.json({ summary: '', priority: 'medium', client_explanation: '', technical_explanation: '', recommended_fix: '', example_copy: '', confidence: 0, ai_available: true, error: 'Unexpected AI error' });
  }
});

aiAssistRouter.post('/ai/recommend', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  try {
    const result = await generateClientRecommendation(
      body.finding,
      toPageContext(body.pageContext),
      optStr(body.language),
    );
    res.json(result);
  } catch (err) {
    console.error('POST /api/ai/recommend error:', err);
    res.json({ summary: '', priority: 'medium', client_explanation: '', technical_explanation: '', recommended_fix: '', example_copy: '', confidence: 0, ai_available: true, error: 'Unexpected AI error' });
  }
});

aiAssistRouter.post('/ai/rewrite-title', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  try {
    const result = await rewriteMetaTitle(
      str(body.currentTitle),
      toPageContext(body.pageContext),
      optStr(body.targetKeyword),
      optStr(body.language),
    );
    res.json(result);
  } catch (err) {
    console.error('POST /api/ai/rewrite-title error:', err);
    res.json({ summary: '', priority: 'medium', client_explanation: '', technical_explanation: '', recommended_fix: '', example_copy: '', confidence: 0, ai_available: true, error: 'Unexpected AI error' });
  }
});

aiAssistRouter.post('/ai/rewrite-description', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  try {
    const result = await rewriteMetaDescription(
      str(body.currentDescription),
      toPageContext(body.pageContext),
      optStr(body.targetKeyword),
      optStr(body.language),
    );
    res.json(result);
  } catch (err) {
    console.error('POST /api/ai/rewrite-description error:', err);
    res.json({ summary: '', priority: 'medium', client_explanation: '', technical_explanation: '', recommended_fix: '', example_copy: '', confidence: 0, ai_available: true, error: 'Unexpected AI error' });
  }
});
