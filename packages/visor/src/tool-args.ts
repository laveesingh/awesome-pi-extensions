import { truncateArg } from "./format.js";

// ── Tool display: arg summaries ──────────────────────────────────────────────
export function toolArgSummary(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "google_search":
    case "web_search":
      return (args.query as string) ? `"${truncateArg(args.query, 50)}"` : "";
    case "web_fetch":
      return truncateArg(args.url, 50);
    case "fetch_content":
      return truncateArg((args.url as string) ?? (args.urls as string) ?? "", 50);
    case "get_search_content":
      return String(args.responseId ?? args.url ?? "");
    case "source_check":
      return truncateArg(args.claim ?? "", 50);
    case "ticket_get":
    case "ticket_dispatch":
    case "ticket_update":
      return String(args.id ?? args.ticket ?? "");
    case "ticket_create":
      return truncateArg(args.title ?? args.kind ?? "", 40);
    case "ticket_list":
      return args.project ? String(args.project) : "";
    case "ticket_comment":
    case "ticket_comment_reply":
      return String(args.id ?? "");
    case "TaskList":
    case "web_enable":
    case "project_context":
    case "sessions_dispatchable":
      return "";
    case "session_notify":
      return truncateArg(args.text ?? "", 40);
    case "session_role":
      return String(args.role ?? "");
    case "ack":
      return String(args.kind ?? "");
    case "respond":
      return truncateArg(args.text ?? "", 40);
    case "bash":
    case "powershell":
      return truncateArg(args.command ?? "", 120);
    case "codemode":
      return truncateArg(String(args.code ?? "").replace(/\s+/g, " ").trim(), 120);
    case "TaskCreate":
      return truncateArg(args.subject ?? "", 60);
    case "TaskUpdate":
      return [args.taskId, args.status, args.subject ? truncateArg(args.subject, 60) : ""].filter(Boolean).join(" ");
    case "grep":
      return truncateArg(args.pattern ?? args.query ?? "", 80);
    case "glob":
    case "find":
      return String(args.pattern ?? "");
    case "look_at":
      return String(args.path ?? args.file ?? "");
    case "interactive_bash":
      return truncateArg(args.command ?? "", 50);
    default:
      return Object.keys(args).length ? `${Object.keys(args).length} args` : "";
  }
}
