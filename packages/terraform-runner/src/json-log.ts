/** One line of `terraform apply|destroy -json`. */
interface JsonLine {
  "@level"?: string;
  "@message"?: string;
  type?: string;
  /** On "diagnostic" lines: the why (e.g. the AWS AccessDenied text). */
  diagnostic?: { severity?: string; summary?: string; detail?: string };
}

const LOGGED_TYPES = new Set([
  "apply_start",
  "apply_complete",
  "apply_errored",
  "change_summary",
  "diagnostic",
]);

/**
 * Streams `-json` output to the job log and keeps its errors. In JSON mode
 * Terraform writes errors to stdout as diagnostics -- stderr stays empty --
 * and the reason is in the diagnostic's detail, not its one-line @message.
 */
export function jsonLogReader(
  onLog: (line: string, stream?: "stdout" | "stderr") => unknown,
  loggedTypes: ReadonlySet<string> = LOGGED_TYPES,
) {
  const errors: string[] = [];
  return {
    onLine(line: string) {
      let parsed: JsonLine;
      try {
        parsed = JSON.parse(line) as JsonLine;
      } catch {
        void onLog(line);
        return;
      }
      if (!parsed.type || !loggedTypes.has(parsed.type) || !parsed["@message"]) return;
      const isError = parsed["@level"] === "error";
      void onLog(parsed["@message"], isError ? "stderr" : "stdout");
      const detail = parsed.diagnostic?.detail?.trim();
      if (parsed.type === "diagnostic" && detail) {
        for (const l of detail.split("\n").filter((l) => l.trim()))
          void onLog(`  ${l}`, isError ? "stderr" : "stdout");
      }
      if (parsed.type === "diagnostic" && isError) {
        const summary = parsed.diagnostic?.summary ?? parsed["@message"];
        errors.push(detail ? `${summary}: ${detail.replace(/\s+/g, " ")}` : summary);
      }
    },
    /** Terraform's errors, else its stderr: what to put in the failure message. */
    errorText(stderr: string): string {
      return (errors.length ? errors.join("; ") : stderr.trim()).slice(0, 1500);
    },
  };
}
