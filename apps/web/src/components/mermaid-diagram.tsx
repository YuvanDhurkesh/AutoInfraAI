"use client";

import { useEffect, useId, useState } from "react";

/**
 * The diagram source is LLM output derived from an untrusted repository, so
 * Mermaid runs with securityLevel "strict" (HTML in labels is escaped, click
 * handlers are disabled). On a parse error we show the raw source instead.
 */
export function MermaidDiagram({ source }: { source: string }) {
  const id = useId().replace(/:/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" });
        const { svg } = await mermaid.render(`mermaid-${id}`, source);
        if (!cancelled) setSvg(svg);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, source]);

  if (failed) {
    return (
      <pre className="overflow-x-auto rounded border border-slate-700 bg-slate-900 p-3 text-xs text-slate-400">
        {source}
      </pre>
    );
  }
  if (!svg) return <p className="text-sm text-slate-500">Rendering diagram...</p>;
  return (
    <div
      className="overflow-x-auto rounded border border-slate-700 bg-slate-900 p-4"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
