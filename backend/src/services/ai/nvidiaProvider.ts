/**
 * NVIDIA NIM AI Provider — optional, additive backend AI layer.
 *
 * This module NEVER decides whether an SEO issue exists. It runs strictly
 * AFTER the deterministic audit engine has produced a finding, and only
 * explains, summarizes, prioritizes, or rewrites copy for an issue that the
 * crawler / checklist / severity logic already detected.
 *
 * Safety contract:
 *   - Reads config from the three env vars the operator provided:
 *       NVIDIA_API_KEY, NVIDIA_BASE_URL, NVIDIA_MODEL
 *   - If ANY of them is missing, AI features are disabled and every public
 *     function returns a clean disabled-fallback. The audit keeps working.
 *   - All network calls are server-side only and time-bounded. On any error
 *     (timeout, non-2xx, bad JSON) we return a structured fallback rather than
 *     throwing, so the audit page never breaks.
 *   - Only a small, bounded slice of page context is ever sent to NVIDIA —
 *     never the full crawl payload or raw page HTML.
 */

const SYSTEM_PROMPT =
  'You are an expert SEO audit assistant. You explain existing SEO audit ' +
  'findings clearly. You do not invent issues.';

/**
 * Default request timeout. Reasoning-capable models (e.g. Nemotron) can be slow
 * even with thinking disabled, so give a generous bound while still capping it
 * so a stuck upstream never hangs the UI forever.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

export type Priority = 'low' | 'medium' | 'high' | 'critical';

/** The structured shape every AI helper resolves to. */
export interface AiStructuredResponse {
  summary: string;
  priority: Priority;
  client_explanation: string;
  technical_explanation: string;
  recommended_fix: string;
  example_copy: string;
  confidence: number;
  /** Present only when the response is a graceful fallback (no/failed AI). */
  ai_available?: boolean;
  error?: string;
}

/** Minimal, bounded context passed in from the caller (the route layer). */
export interface PageContext {
  url?: string;
  /** The audit issue / check key, e.g. "missing-meta-description". */
  issueType?: string;
  currentTitle?: string;
  currentMetaDescription?: string;
  /** Short summary of the H1/H2 outline — NOT the full DOM. */
  headingSummary?: string;
  /** The detected issue data straight from the deterministic audit. */
  detectedIssue?: unknown;
  /** Optional, limited page text. Caller must keep this small. */
  pageTextExcerpt?: string;
}

/* ────────────────────────────────────────────────────────────────────────
 * Configuration
 * ──────────────────────────────────────────────────────────────────────── */

interface NvidiaConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/**
 * Reads NVIDIA config from the environment. Returns null when any of the three
 * required variables is absent/blank — the signal that AI features are off.
 *
 * Uses ONLY: process.env.NVIDIA_API_KEY / NVIDIA_BASE_URL / NVIDIA_MODEL.
 */
function getNvidiaConfig(): NvidiaConfig | null {
  const apiKey = (process.env.NVIDIA_API_KEY ?? '').trim();
  const baseUrl = (process.env.NVIDIA_BASE_URL ?? '').trim();
  const model = (process.env.NVIDIA_MODEL ?? '').trim();

  if (!apiKey || !baseUrl || !model) return null;

  // Normalise: drop any trailing slash so `${baseUrl}/chat/completions` is clean.
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), model };
}

/** Public, side-effect-free check the route/UI can use to show or hide AI actions. */
export function isAiEnabled(): boolean {
  return getNvidiaConfig() !== null;
}

/**
 * Non-secret diagnostics for the /api/ai/status and /api/ai/test endpoints.
 * Reports WHICH of the three vars are present (booleans only) plus the model
 * name and the base URL's host — never the API key itself.
 */
export function getConfigStatus(): {
  enabled: boolean;
  hasApiKey: boolean;
  hasBaseUrl: boolean;
  hasModel: boolean;
  baseUrlHost: string | null;
  model: string | null;
} {
  const hasApiKey = !!(process.env.NVIDIA_API_KEY ?? '').trim();
  const hasBaseUrl = !!(process.env.NVIDIA_BASE_URL ?? '').trim();
  const hasModel = !!(process.env.NVIDIA_MODEL ?? '').trim();
  const config = getNvidiaConfig();
  let baseUrlHost: string | null = null;
  if (config) {
    try {
      baseUrlHost = new URL(config.baseUrl).host;
    } catch {
      baseUrlHost = config.baseUrl;
    }
  }
  return {
    enabled: config !== null,
    hasApiKey,
    hasBaseUrl,
    hasModel,
    baseUrlHost,
    model: config?.model ?? null,
  };
}

/**
 * Live connection test: makes one tiny chat-completions call and reports the
 * outcome with latency. Never throws — returns a structured diagnostic. Use
 * from /api/ai/test to verify the NVIDIA key/URL/model actually work end-to-end.
 */
export async function testNvidiaConnection(): Promise<{
  ok: boolean;
  status: 'disabled' | 'success' | 'failed';
  message: string;
  model: string | null;
  config: ReturnType<typeof getConfigStatus>;
  latencyMs?: number;
  sample?: string;
}> {
  const config = getNvidiaConfig();
  const status = getConfigStatus();

  if (!config) {
    const missing = [
      !status.hasApiKey ? 'NVIDIA_API_KEY' : null,
      !status.hasBaseUrl ? 'NVIDIA_BASE_URL' : null,
      !status.hasModel ? 'NVIDIA_MODEL' : null,
    ].filter(Boolean);
    return {
      ok: false,
      status: 'disabled',
      message: `AI disabled — missing env var(s): ${missing.join(', ')}`,
      model: status.model,
      config: status,
    };
  }

  // Minimal test request. We ask for a one-sentence confirmation rather than a
  // single token — some NIM models (e.g. diffusiongemma) return empty content
  // for ultra-short prompts, so a sentence-length ask is a reliable probe.
  const startedAt = Date.now();
  const raw = await callNvidiaChat('Respond with a one-sentence confirmation that you are working.', {
    timeoutMs: 30_000,
    maxTokens: 128,
    withSystemPrompt: false,
  });
  const latencyMs = Date.now() - startedAt;

  if (raw == null) {
    return {
      ok: false,
      status: 'failed',
      message:
        'NVIDIA call failed (timeout, auth error, wrong base URL/model, or network). ' +
        'Check server logs for the [nvidiaProvider] line.',
      model: config.model,
      config: status,
      latencyMs,
    };
  }

  return {
    ok: true,
    status: 'success',
    message: 'NVIDIA NIM connection succeeded.',
    model: config.model,
    config: status,
    latencyMs,
    sample: raw.slice(0, 200),
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Low-level NVIDIA call
 * ──────────────────────────────────────────────────────────────────────── */

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface CallOptions {
  /** Abort after this many ms. */
  timeoutMs?: number;
  /** Cap output tokens. Normal assist calls use 4096; the connection test uses 64. */
  maxTokens?: number;
  /** When false, omit the system prompt (used by the minimal connection test). */
  withSystemPrompt?: boolean;
}

/**
 * POST `${NVIDIA_BASE_URL}/chat/completions` (OpenAI-compatible).
 * Returns the assistant message string, or null on any failure.
 * Never throws. We keep the request body deliberately simple — no
 * model-specific flags like chat_template_kwargs — so it works across NVIDIA
 * NIM models (e.g. google/diffusiongemma-26b-a4b-it) without 400 errors.
 */
async function callNvidiaChat(
  userContent: string,
  opts: CallOptions = {},
): Promise<string | null> {
  const config = getNvidiaConfig();
  if (!config) return null;

  // Never send empty user content upstream — it wastes a call and some models 400.
  if (!userContent || !userContent.trim()) {
    console.warn('[nvidiaProvider] Refusing to send empty user content');
    return null;
  }

  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxTokens = 4096, withSystemPrompt = true } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const messages: ChatMessage[] = [];
    if (withSystemPrompt) messages.push({ role: 'system', content: SYSTEM_PROMPT });
    messages.push({ role: 'user', content: userContent });

    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: maxTokens,
        temperature: 1.0,
        top_p: 0.95,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn(
        `[nvidiaProvider] NVIDIA API responded ${res.status} ${res.statusText} ${detail.slice(0, 300)}`,
      );
      return null;
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = json?.choices?.[0]?.message?.content;
    return typeof content === 'string' && content.trim() ? content : null;
  } catch (err) {
    // AbortError (timeout) and network errors all land here — stay silent-safe.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[nvidiaProvider] NVIDIA call failed: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Response parsing & fallbacks
 * ──────────────────────────────────────────────────────────────────────── */

const VALID_PRIORITIES: Priority[] = ['low', 'medium', 'high', 'critical'];

/** A clean, predictable fallback when AI is off or the call/parse fails. */
function fallbackResponse(reason: string, aiAvailable: boolean): AiStructuredResponse {
  return {
    summary: '',
    priority: 'medium',
    client_explanation: '',
    technical_explanation: '',
    recommended_fix: '',
    example_copy: '',
    confidence: 0,
    ai_available: aiAvailable,
    error: reason,
  };
}

/**
 * Pull a JSON object out of the model's text. Reasoning-style models may wrap
 * JSON in ```json fences or precede it with prose, so we extract the first
 * balanced `{ ... }` block before parsing. Returns a normalised, fully-typed
 * structured response, or null if nothing usable was found.
 */
function parseStructuredResponse(raw: string): AiStructuredResponse | null {
  let text = raw.trim();

  // Strip Markdown code fences if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  // Fall back to the first {...} span if there is leading/trailing prose.
  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    text = text.slice(start, end + 1);
  }

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }

  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const priorityRaw = String(obj.priority ?? '').toLowerCase() as Priority;
  const priority: Priority = VALID_PRIORITIES.includes(priorityRaw) ? priorityRaw : 'medium';

  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.min(1, Math.max(0, confidence));

  return {
    summary: str(obj.summary),
    priority,
    client_explanation: str(obj.client_explanation),
    technical_explanation: str(obj.technical_explanation),
    recommended_fix: str(obj.recommended_fix),
    example_copy: str(obj.example_copy),
    confidence,
    ai_available: true,
  };
}

/** Build the JSON-output contract appended to every prompt. */
function jsonInstruction(): string {
  return [
    '',
    'Respond with ONLY a single valid JSON object, no Markdown, using exactly these keys:',
    '{',
    '  "summary": "",',
    '  "priority": "low | medium | high | critical",',
    '  "client_explanation": "",',
    '  "technical_explanation": "",',
    '  "recommended_fix": "",',
    '  "example_copy": "",',
    '  "confidence": 0.0',
    '}',
    'The "priority" must reflect the SEO impact of the ALREADY-DETECTED issue; do not invent new issues.',
    '"confidence" is your confidence in the explanation, between 0.0 and 1.0.',
  ].join('\n');
}

/**
 * Serialise only the bounded context. Long fields are truncated defensively so
 * we never ship the full crawl/HTML upstream even if a caller over-supplies.
 */
function renderContext(ctx: PageContext): string {
  const clip = (v: unknown, max: number): string => {
    const s = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  };
  const lines: string[] = [];
  if (ctx.url) lines.push(`URL: ${clip(ctx.url, 300)}`);
  if (ctx.issueType) lines.push(`Issue type: ${clip(ctx.issueType, 120)}`);
  if (ctx.currentTitle != null) lines.push(`Current title: ${clip(ctx.currentTitle, 300)}`);
  if (ctx.currentMetaDescription != null)
    lines.push(`Current meta description: ${clip(ctx.currentMetaDescription, 500)}`);
  if (ctx.headingSummary) lines.push(`Heading outline (H1/H2): ${clip(ctx.headingSummary, 600)}`);
  if (ctx.detectedIssue !== undefined)
    lines.push(`Detected issue data: ${clip(ctx.detectedIssue, 1500)}`);
  if (ctx.pageTextExcerpt) lines.push(`Page text excerpt: ${clip(ctx.pageTextExcerpt, 1500)}`);
  return lines.join('\n');
}

/** Resolve a language hint into a clear instruction. Defaults to English. */
function langLine(language?: string): string {
  const lang = (language ?? '').trim();
  return lang ? `Write all human-readable text in this language: ${lang}.` : 'Write in English.';
}

/** Where to place raw prose when a model returns text instead of strict JSON. */
type PrimaryField =
  | 'summary'
  | 'client_explanation'
  | 'technical_explanation'
  | 'example_copy';

/**
 * Shared runner: builds the prompt, calls NVIDIA, parses, and falls back safely.
 *
 * Some NIM models (e.g. google/diffusiongemma-26b-a4b-it) are chatty and ignore
 * strict-JSON instructions, returning Markdown prose. Rather than show the user
 * an empty result, we degrade gracefully: the raw text is placed into the most
 * relevant field for the action so the AI Assist panel still shows useful output.
 */
async function runStructured(
  promptBody: string,
  primaryField: PrimaryField,
): Promise<AiStructuredResponse> {
  if (!isAiEnabled()) return fallbackResponse('AI provider not configured', false);

  const raw = await callNvidiaChat(`${promptBody}\n${jsonInstruction()}`, { maxTokens: 4096 });
  if (raw == null) return fallbackResponse('AI request failed or timed out', true);

  const parsed = parseStructuredResponse(raw);
  if (parsed) return parsed;

  // Not valid JSON — surface the prose in the primary field instead of failing.
  return {
    summary: '',
    priority: 'medium',
    client_explanation: '',
    technical_explanation: '',
    recommended_fix: '',
    example_copy: '',
    confidence: 0.5,
    ai_available: true,
    [primaryField]: raw.trim(),
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Public functions
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Explain an already-detected audit finding (technical + plain-language).
 * The finding MUST come from the deterministic audit — AI only explains it.
 */
export function generateAuditExplanation(
  auditFinding: unknown,
  pageContext: PageContext,
  language?: string,
): Promise<AiStructuredResponse> {
  const body = [
    'An SEO audit has ALREADY detected the following issue for a page.',
    'Explain this existing finding. Do not invent new issues.',
    langLine(language),
    '',
    'Page context:',
    renderContext(pageContext),
    '',
    `Detected finding: ${safeJson(auditFinding)}`,
  ].join('\n');
  return runStructured(body, 'technical_explanation');
}

/**
 * Turn an already-detected finding into a client-facing recommendation:
 * a non-technical explanation plus a concrete recommended fix.
 */
export function generateClientRecommendation(
  auditFinding: unknown,
  pageContext: PageContext,
  language?: string,
): Promise<AiStructuredResponse> {
  const body = [
    'An SEO audit has ALREADY detected the following issue.',
    'Produce a clear, non-technical recommendation a client can act on.',
    'Focus client_explanation on business impact and recommended_fix on the action.',
    'Do not invent new issues.',
    langLine(language),
    '',
    'Page context:',
    renderContext(pageContext),
    '',
    `Detected finding: ${safeJson(auditFinding)}`,
  ].join('\n');
  return runStructured(body, 'client_explanation');
}

/**
 * Rewrite a meta title for an already-flagged page. Put the best new title in
 * `example_copy`. AI is rewriting copy, not deciding the page has an issue.
 */
export function rewriteMetaTitle(
  currentTitle: string,
  pageContext: PageContext,
  targetKeyword: string | undefined,
  language?: string,
): Promise<AiStructuredResponse> {
  const body = [
    'Rewrite the META TITLE for this page to be more effective for SEO.',
    'Aim for roughly 50–60 characters. Keep it accurate to the page.',
    'Return the single best new title in "example_copy". Do not invent page facts.',
    targetKeyword ? `Target keyword to include naturally: ${targetKeyword}.` : '',
    langLine(language),
    '',
    `Current title: ${currentTitle ?? ''}`,
    '',
    'Page context:',
    renderContext(pageContext),
  ]
    .filter(Boolean)
    .join('\n');
  return runStructured(body, 'example_copy');
}

/**
 * Rewrite a meta description for an already-flagged page. Put the best new
 * description in `example_copy`.
 */
export function rewriteMetaDescription(
  currentDescription: string,
  pageContext: PageContext,
  targetKeyword: string | undefined,
  language?: string,
): Promise<AiStructuredResponse> {
  const body = [
    'Rewrite the META DESCRIPTION for this page to be more compelling and click-worthy.',
    'Aim for roughly 140–160 characters. Keep it accurate to the page.',
    'Return the single best new description in "example_copy". Do not invent page facts.',
    targetKeyword ? `Target keyword to include naturally: ${targetKeyword}.` : '',
    langLine(language),
    '',
    `Current meta description: ${currentDescription ?? ''}`,
    '',
    'Page context:',
    renderContext(pageContext),
  ]
    .filter(Boolean)
    .join('\n');
  return runStructured(body, 'example_copy');
}

/** JSON.stringify that never throws and stays bounded. */
function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 2000 ? `${s.slice(0, 2000)}…` : s ?? '';
  } catch {
    return String(v);
  }
}
