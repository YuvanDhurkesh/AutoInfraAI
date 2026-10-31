"use client";

import { useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "@/lib/api-client";

interface LogLine {
  seq: number;
  line: string;
  stream: "stdout" | "stderr";
}

const TITLES: Record<string, string> = {
  analyze: "Cloning and scanning the repository",
  design: "Designing the architecture with Gemini",
  generate: "Generating and validating Terraform (this can take several minutes)",
  apply: "Deploying: apply, build, and health checks (CloudFront alone can take 5-15 minutes)",
  destroy: "Destroying everything this deployment created (CloudFront can take 5-15 minutes)",
};

/**
 * Live job log over Server-Sent Events. EventSource reconnects on its own
 * with Last-Event-ID, and the server only replays lines after that id, so a
 * dropped connection doesn't duplicate or lose lines.
 */
export function JobConsole({
  jobId,
  kind,
  live,
  onFinished,
}: {
  jobId: string;
  kind: string;
  live: boolean;
  onFinished: () => void;
}) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  // Survives reconnects (the job finishing, React dev double-mount): the
  // server replays the whole backlog to each new stream.
  const seenRef = useRef(new Set<number>());

  useEffect(() => {
    const source = new EventSource(`${API_BASE_URL}/jobs/${jobId}/logs/stream`, {
      withCredentials: true,
    });
    const seen = seenRef.current;
    source.onopen = () => setConnected(true);
    source.addEventListener("log", (event) => {
      const line = JSON.parse((event as MessageEvent).data) as LogLine;
      if (seen.has(line.seq)) return;
      seen.add(line.seq);
      setLines((prev) => [...prev, line]);
    });
    source.addEventListener("end", () => {
      source.close();
      setConnected(false);
      if (live) onFinished();
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [jobId, live, onFinished]);

  useEffect(() => {
    if (live) bottom.current?.scrollIntoView({ block: "nearest" });
  }, [lines, live]);

  return (
    <details open={live} className="rounded border border-slate-700 bg-slate-900">
      <summary className="cursor-pointer px-3 py-2 text-sm text-slate-300">
        {live ? `${TITLES[kind] ?? "Working"}...` : `Log: ${kind}`}
        {live && (
          <span className={`ml-2 text-xs ${connected ? "text-emerald-400" : "text-slate-500"}`}>
            {connected ? "● live" : "○ reconnecting"}
          </span>
        )}
      </summary>
      <div className="max-h-96 overflow-y-auto border-t border-slate-800 px-3 py-2 font-mono text-xs">
        {lines.length === 0 && <p className="text-slate-500">Waiting for output...</p>}
        {lines.map((l) => (
          <div
            key={l.seq}
            className={`whitespace-pre-wrap ${l.stream === "stderr" ? "text-red-300" : l.line.startsWith("==") ? "font-semibold text-indigo-300" : "text-slate-300"}`}
          >
            {l.line}
          </div>
        ))}
        <div ref={bottom} />
      </div>
    </details>
  );
}
