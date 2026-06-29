/**
 * AiAssist — optional, self-contained AI helper UI for a single audit result.
 *
 * This component is purely additive: it reads an already-produced audit result
 * (URL, detected recommendations, contentMeta) and asks the backend to EXPLAIN,
 * RECOMMEND, or REWRITE copy. It never runs or alters the audit itself.
 *
 * It self-disables: on mount it asks GET /api/ai/status and, if AI is not
 * configured on the server (NVIDIA_* env vars missing), it renders nothing —
 * so the audit page looks and works exactly as before.
 *
 * All NVIDIA calls happen server-side; this component only talks to /api/ai/*.
 */

import { useEffect, useState } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

interface Recommendation {
  priority: string;
  area: string;
  message: string;
  fixHint: string;
}

interface AiResult {
  summary?: string;
  priority?: string;
  client_explanation?: string;
  technical_explanation?: string;
  recommended_fix?: string;
  example_copy?: string;
  confidence?: number;
  ai_available?: boolean;
  error?: string;
}

interface AiAssistProps {
  url: string;
  data: Record<string, unknown> | null;
  recommendations: Recommendation[] | null;
}

/** Build the small, bounded context the backend expects — never the full data. */
function buildContext(props: AiAssistProps) {
  const meta = (props.data?.contentMeta as Record<string, unknown> | null) ?? null;
  const title = typeof meta?.title === 'string' ? meta.title : '';
  const description = typeof meta?.description === 'string' ? meta.description : '';
  const h1 = typeof meta?.h1 === 'string' ? meta.h1 : '';
  const headingSummary = h1 ? `H1: ${h1}` : undefined;
  const pageType = typeof props.data?.pageType === 'string' ? props.data.pageType : undefined;

  return {
    title,
    description,
    pageContext: {
      url: props.url,
      issueType: (props.recommendations ?? []).map((r) => r.area).join(', ') || pageType,
      currentTitle: title,
      currentMetaDescription: description,
      headingSummary,
    },
  };
}

export default function AiAssist(props: AiAssistProps) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [result, setResult] = useState<AiResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Probe whether AI is configured server-side. Fail closed (hidden) on error.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/ai/status`)
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((j) => !cancelled && setEnabled(!!j.enabled))
      .catch(() => !cancelled && setEnabled(false));
    return () => {
      cancelled = true;
    };
  }, []);

  if (enabled !== true) return null; // hidden until confirmed available

  const { title, description, pageContext } = buildContext(props);
  // The "finding" is the deterministic audit's own recommendations — AI only explains it.
  const finding = props.recommendations ?? {};

  async function run(action: string, endpoint: string, body: Record<string, unknown>) {
    setLoading(action);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/ai/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json: AiResult = await res.json();
      if (json.error || json.ai_available === false) {
        setError(json.error || 'AI is not available right now.');
        setResult(json);
      } else {
        setResult(json);
      }
    } catch {
      setError('AI request failed. The audit result above is unaffected.');
    } finally {
      setLoading(null);
    }
  }

  const btn =
    'inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg ' +
    'border border-violet-200 text-violet-700 bg-violet-50 hover:bg-violet-100 ' +
    'disabled:opacity-50 disabled:cursor-not-allowed transition-colors';

  return (
    <div className="mt-3 rounded-lg border border-violet-100 bg-violet-50/40 p-3">
      <div className="flex items-center gap-1.5 mb-2">
        <Sparkles className="w-3.5 h-3.5 text-violet-600" />
        <span className="text-xs font-semibold text-violet-700">AI Assist</span>
        <span className="text-[10px] text-slate-400">(explains the result above — never changes it)</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          className={btn}
          disabled={loading !== null}
          onClick={() => run('explain', 'explain', { finding, pageContext })}
        >
          {loading === 'explain' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
          Generate AI Explanation
        </button>
        <button
          className={btn}
          disabled={loading !== null}
          onClick={() => run('recommend', 'recommend', { finding, pageContext })}
        >
          {loading === 'recommend' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
          Generate Client Recommendation
        </button>
        <button
          className={btn}
          disabled={loading !== null}
          onClick={() => run('rewrite-title', 'rewrite-title', { currentTitle: title, pageContext })}
        >
          {loading === 'rewrite-title' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
          Rewrite Meta Title
        </button>
        <button
          className={btn}
          disabled={loading !== null}
          onClick={() => run('rewrite-description', 'rewrite-description', { currentDescription: description, pageContext })}
        >
          {loading === 'rewrite-description' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
          Rewrite Meta Description
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-amber-700 bg-amber-50 px-3 py-1.5 rounded">{error}</p>}

      {result && !error && (
        <div className="mt-3 space-y-2 text-xs">
          {result.summary && (
            <Field label="Summary" value={result.summary} />
          )}
          {result.priority && (
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-600">AI priority:</span>
              <span className="font-semibold text-violet-700 uppercase">{result.priority}</span>
              {typeof result.confidence === 'number' && (
                <span className="text-slate-400">confidence {Math.round(result.confidence * 100)}%</span>
              )}
            </div>
          )}
          {result.client_explanation && <Field label="Client explanation" value={result.client_explanation} />}
          {result.technical_explanation && <Field label="Technical explanation" value={result.technical_explanation} />}
          {result.recommended_fix && <Field label="Recommended fix" value={result.recommended_fix} />}
          {result.example_copy && <Field label="Example / new copy" value={result.example_copy} copyable />}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="bg-white rounded-md border border-slate-100 px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-slate-600">{label}</span>
        {copyable && (
          <button
            className="text-[10px] text-violet-600 hover:underline"
            onClick={() => {
              navigator.clipboard?.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      <p className="text-slate-700 mt-0.5 whitespace-pre-wrap">{value}</p>
    </div>
  );
}
