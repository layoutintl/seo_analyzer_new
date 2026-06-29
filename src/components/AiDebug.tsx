/**
 * AiDebug — small, safe diagnostic badge for the AI Assist feature.
 *
 * It is hidden by default. It only renders when EITHER:
 *   - the app is running in a Vite dev build (import.meta.env.DEV), OR
 *   - the page URL contains ?aidebug=1  (a safe, temporary opt-in for prod)
 *
 * It shows, at a glance, why the AI Assist panel may or may not appear:
 *   - whether GET /api/ai/status has loaded
 *   - whether AI is enabled (all three NVIDIA_* env vars present server-side)
 *   - the model in use
 *   - whether an audit result + page rows are available in the UI
 *
 * It performs no writes and never affects the audit. Remove the <AiDebug/> usage
 * (or just ignore it — it self-hides) once everything is confirmed working.
 */

import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

interface AiStatus {
  enabled?: boolean;
  hasApiKey?: boolean;
  hasBaseUrl?: boolean;
  hasModel?: boolean;
  model?: string | null;
  baseUrlHost?: string | null;
}

interface AiDebugProps {
  auditAvailable: boolean;
  pageCount: number;
}

function debugEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    return new URLSearchParams(window.location.search).has('aidebug');
  } catch {
    return false;
  }
}

export default function AiDebug({ auditAvailable, pageCount }: AiDebugProps) {
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!debugEnabled()) return;
    let cancelled = false;
    fetch(`${API_BASE}/api/ai/status`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: AiStatus) => {
        if (cancelled) return;
        setStatus(j);
        setLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setFetchError(e instanceof Error ? e.message : String(e));
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!debugEnabled()) return null;

  const Row = ({ label, value, ok }: { label: string; value: string; ok: boolean | null }) => (
    <div className="flex items-center gap-2">
      <span
        className={
          'w-2 h-2 rounded-full inline-block ' +
          (ok === null ? 'bg-slate-300' : ok ? 'bg-green-500' : 'bg-red-500')
        }
      />
      <span className="text-slate-500">{label}:</span>
      <span className="font-mono text-slate-800">{value}</span>
    </div>
  );

  return (
    <div className="bg-slate-900 text-slate-100 rounded-xl px-4 py-3 text-[11px] shadow-lg">
      <div className="flex items-center gap-2 mb-2 font-semibold text-violet-300">
        <span>AI Assist — debug</span>
        <span className="text-slate-400 font-normal">(dev or ?aidebug=1 only)</span>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <Row label="status loaded" value={loaded ? 'yes' : 'loading…'} ok={loaded ? true : null} />
        <Row
          label="/api/ai/status"
          value={fetchError ? `error: ${fetchError}` : status ? 'reachable' : '…'}
          ok={fetchError ? false : status ? true : null}
        />
        <Row label="AI enabled" value={String(!!status?.enabled)} ok={status ? !!status.enabled : null} />
        <Row label="model" value={status?.model || '—'} ok={status?.model ? true : null} />
        <Row label="has API key" value={String(!!status?.hasApiKey)} ok={status ? !!status.hasApiKey : null} />
        <Row label="has base URL" value={String(!!status?.hasBaseUrl)} ok={status ? !!status.hasBaseUrl : null} />
        <Row label="has model var" value={String(!!status?.hasModel)} ok={status ? !!status.hasModel : null} />
        <Row label="base URL host" value={status?.baseUrlHost || '—'} ok={status?.baseUrlHost ? true : null} />
        <Row label="audit available" value={String(auditAvailable)} ok={auditAvailable} />
        <Row label="page rows" value={String(pageCount)} ok={pageCount > 0} />
      </div>
      <p className="mt-2 text-slate-400">
        AI buttons appear inside each expanded page section when <span className="text-violet-300">AI enabled = true</span>.
      </p>
    </div>
  );
}
