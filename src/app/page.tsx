"use client";

import React, { useMemo, useState, useTransition } from "react";

type RetrievedIssue = {
  issue_id?: string;
  issue_title?: string;
  user_problem?: string;
  recommendation?: string;
  page_type?: string[];
  signals_to_detect?: string[];
  confidence_weight?: number;
  severity?: string;
};

type ApiResponse = {
  report: string;
  retrievedIssues?: RetrievedIssue[];
  finalIssues?: RetrievedIssue[];
  total_estimated_fix_hours?: number;
  usedMock?: boolean;
  note?: string;
  model?: string;
  usedCompany?: boolean;
  error?: string;
};

const defaultForm = {
  url: "",
  goal: "",
  model: "openrouter/auto",
  useCompany: true,
  topK: 7,
};

// generate a human-readable instruction for screenshots based on primary goal text
function getScreenshotInstruction(goal: string) {
  const text = goal.toLowerCase();
  if (text.includes("checkout")) {
    return "Upload screenshots that clearly show the checkout process (cart, shipping, payment, confirmation).";
  }
  if (text.includes("login") || text.includes("sign in") || text.includes("authentication")) {
    return "Provide screenshots of the login/registration flow including error messages or form fields.  ";
  }
  if (text.includes("navigation") || text.includes("menu") || text.includes("search")) {
    return "Include images of the navigation elements or search interactions you want audited.";
  }
  if (text.includes("profile") || text.includes("account")) {
    return "Capture the user account or profile pages relevant to your goal.";
  }
  // default generic guidance
  return "Screenshots should clearly illustrate the portion of the site related to your goal; include the relevant pages or flows.";
}


function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
      <span className="text-slate-500">{label}</span>{" "}
      <span className="font-semibold text-slate-800">{value}</span>
    </div>
  );
}

function SeverityDashboard({ issues }: { issues: RetrievedIssue[] }) {
  const confidenceCounts = {
    highConfidence: issues.filter((i) => (i.confidence_weight ?? 0.7) >= 0.8).length,
    mediumConfidence: issues.filter((i) => {
      const conf = i.confidence_weight ?? 0.7;
      return conf >= 0.6 && conf < 0.8;
    }).length,
    lowConfidence: issues.filter((i) => (i.confidence_weight ?? 0.7) < 0.6).length,
  };

  const totalIssues = issues.length;

  return (
    <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-slate-100 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-600 mb-3">
        Issues by Confidence
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {confidenceCounts.highConfidence > 0 && (
          <div className="rounded-lg bg-green-50 px-3 py-2 text-center border border-green-200">
            <p className="text-2xl font-bold text-green-700">{confidenceCounts.highConfidence}</p>
            <p className="text-xs font-medium text-green-600">High Confidence</p>
          </div>
        )}
        {confidenceCounts.mediumConfidence > 0 && (
          <div className="rounded-lg bg-yellow-50 px-3 py-2 text-center border border-yellow-200">
            <p className="text-2xl font-bold text-yellow-700">{confidenceCounts.mediumConfidence}</p>
            <p className="text-xs font-medium text-yellow-600">Medium Confidence</p>
          </div>
        )}
        {confidenceCounts.lowConfidence > 0 && (
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-center border border-slate-300">
            <p className="text-2xl font-bold text-slate-700">{confidenceCounts.lowConfidence}</p>
            <p className="text-xs font-medium text-slate-600">Low Confidence</p>
          </div>
        )}

      </div>
      {totalIssues > 0 && (
        <p className="mt-3 text-xs text-slate-600">
          <span className="font-semibold">{totalIssues} total issue patterns</span> detected and ranked by confidence.
        </p>
      )}
    </div>
  );
}

// Additional dashboard that shows counts by severity level (Critical/Major/Medium/etc)
function SeverityLevelDashboard({ issues }: { issues: RetrievedIssue[] }) {
  const severityCounts: { [s: string]: number } = {};
  for (const it of issues) {
    const s = (it as any).severity as string | undefined;
    if (!s) continue;
    severityCounts[s] = (severityCounts[s] || 0) + 1;
  }

  const entries = Object.entries(severityCounts);
  if (entries.length === 0) return null;

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-600 mb-2">Issues by Severity</p>
      <div className="flex flex-wrap gap-2">
        {entries.map(([sev, count]) => (
          <div key={sev} className="rounded-lg bg-slate-50 px-3 py-2 text-center border border-slate-200">
            <p className="text-sm font-bold text-slate-900">{count}</p>
            <p className="text-xs text-slate-600">{sev}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function IssueFeedbackRow({
  reportId, url, siteType, issueId, issueTitle, confidenceScore,
}: {
  reportId: string; url: string; siteType: string;
  issueId: string | null | undefined;
  issueTitle: string | null | undefined;
  confidenceScore: number | null | undefined;
}) {
  const storageKey = `feedback:issue:${reportId}:${issueId ?? issueTitle ?? "unknown"}`;
  const [submitted, setSubmitted] = useState<1 | -1 | null>(() => {
    if (typeof window === "undefined") return null;
    const v = localStorage.getItem(storageKey);
    return v ? (Number(v) as 1 | -1) : null;
  });
  const [submitting, setSubmitting] = useState(false);

  const handleVote = async (signal: 1 | -1) => {
    if (submitted !== null || submitting || !reportId) return;
    setSubmitting(true);
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          report_id: reportId, url, site_type: siteType,
          feedback_type: "issue",
          issue_id: issueId ?? null, issue_title: issueTitle ?? null,
          signal, confidence_score: confidenceScore ?? null,
        }),
      });
      localStorage.setItem(storageKey, String(signal));
      setSubmitted(signal);
    } catch (e) {
      console.error("[IssueFeedbackRow]", e);
    } finally {
      setSubmitting(false);
    }
  };

  if (!reportId) return null;
  return (
    <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-2">
      <span className="text-[11px] text-slate-400 mr-1">Relevant?</span>
      {submitted !== null ? (
        <span className="text-[11px] font-medium text-emerald-600">Noted ✓</span>
      ) : (
        <>
          <button type="button" onClick={() => handleVote(1)} disabled={submitting}
            title="Thumbs up"
            className="text-sm leading-none opacity-50 hover:opacity-100 transition-opacity disabled:cursor-not-allowed">
            👍
          </button>
          <button type="button" onClick={() => handleVote(-1)} disabled={submitting}
            title="Thumbs down"
            className="text-sm leading-none opacity-50 hover:opacity-100 transition-opacity disabled:cursor-not-allowed">
            👎
          </button>
        </>
      )}
    </div>
  );
}

function IssueCard({ issue, reportId, url, siteType }: {
  issue: RetrievedIssue; reportId: string; url: string; siteType: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-900">
            {issue.issue_title ?? "Issue"}
          </p>
          {issue.issue_id ? (
            <p className="mt-1 text-xs text-slate-500">ID: {issue.issue_id}</p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-1">
          {issue.severity ? (
            <span className="rounded-full bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-700">
              {issue.severity}
            </span>
          ) : null}
          {issue.confidence_weight ? (
            <span className="rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700">
              Confidence {Math.round(issue.confidence_weight * 100)}%
            </span>
          ) : null}
        </div>
      </div>
      {issue.page_type?.length ? (
        <p className="mt-1 text-xs uppercase tracking-wide text-slate-500">
          {issue.page_type.join(" · ")}
        </p>
      ) : null}
      {issue.user_problem ? (
        <p className="mt-2 text-sm text-slate-700">{issue.user_problem}</p>
      ) : null}
      {issue.signals_to_detect?.length ? (
        <div className="mt-2">
          <p className="text-xs font-semibold text-slate-600">Signals</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-slate-700">
            {issue.signals_to_detect.map((signal) => (
              <li key={signal}>{signal}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {issue.recommendation ? (
        <p className="mt-2 text-sm text-slate-800">
          <span className="font-semibold text-slate-900">Recommendation: </span>
          {issue.recommendation}
        </p>
      ) : null}
      <IssueFeedbackRow
        reportId={reportId} url={url} siteType={siteType}
        issueId={issue.issue_id} issueTitle={issue.issue_title}
        confidenceScore={issue.confidence_weight}
      />
    </div>
  );
}

function MarkdownRenderer({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let currentList: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let key = 0;

  const flushList = () => {
    if (currentList.length > 0 && listType) {
      const ListTag = listType === "ul" ? "ul" : "ol";
      elements.push(
        <ListTag key={key++} className="list-disc pl-6 mb-2 space-y-1">
          {currentList.map((item, idx) => (
            <li key={idx} className="mb-1">
              {item.split(/\*\*(.+?)\*\*/).map((part, i) => 
                i % 2 === 1 ? (
                  <strong key={i} className="font-semibold text-slate-900">{part}</strong>
                ) : (
                  part
                )
              )}
            </li>
          ))}
        </ListTag>
      );
      currentList = [];
      listType = null;
    }
  };

  for (let i = 0; i < lines.length && i < 1000; i++) {
    const line = lines[i].trim();

    if (!line) {
      flushList();
      continue;
    }

    if (line.match(/^---+$/)) {
      flushList();
      elements.push(<hr key={key++} className="my-4 border-slate-300" />);
      continue;
    }

    if (line.startsWith("### ")) {
      flushList();
      const text = line.substring(4);
      elements.push(
        <h3 key={key++} className="text-base font-semibold text-slate-900 mt-3 mb-2">
          {text.split(/\*\*(.+?)\*\*/).map((part, i) => 
            i % 2 === 1 ? (
              <strong key={i} className="font-semibold text-slate-900">{part}</strong>
            ) : (
              part
            )
          )}
        </h3>
      );
      continue;
    }

    if (line.startsWith("## ")) {
      flushList();
      const text = line.substring(3);
      elements.push(
        <h2 key={key++} className="text-lg font-semibold text-slate-900 mt-4 mb-2">
          {text.split(/\*\*(.+?)\*\*/).map((part, i) => 
            i % 2 === 1 ? (
              <strong key={i} className="font-semibold text-slate-900">{part}</strong>
            ) : (
              part
            )
          )}
        </h2>
      );
      continue;
    }

    if (line.startsWith("# ")) {
      flushList();
      const text = line.substring(2);
      elements.push(
        <h1 key={key++} className="text-xl font-bold text-slate-900 mt-4 mb-2">
          {text.split(/\*\*(.+?)\*\*/).map((part, i) => 
            i % 2 === 1 ? (
              <strong key={i} className="font-semibold text-slate-900">{part}</strong>
            ) : (
              part
            )
          )}
        </h1>
      );
      continue;
    }

    if (line.match(/^[-*]\s/)) {
      if (listType !== "ul") {
        flushList();
        listType = "ul";
      }
      currentList.push(line.substring(2).trim());
      continue;
    }

    if (line.match(/^\d+\.\s/)) {
      if (listType !== "ol") {
        flushList();
        listType = "ol";
      }
      currentList.push(line.replace(/^\d+\.\s/, "").trim());
      continue;
    }

    flushList();
    elements.push(
      <p key={key++} className="mb-2 text-slate-800">
        {line.split(/\*\*(.+?)\*\*/).map((part, i) => 
          i % 2 === 1 ? (
            <strong key={i} className="font-semibold text-slate-900">{part}</strong>
          ) : (
            part
          )
        )}
      </p>
    );
  }

  flushList();

  return <div>{elements}</div>;
}

function FilterSort({
  issues,
  selectedSeverities,
  setSelectedSeverities,
  selectedPageTypes,
  setSelectedPageTypes,
  sortBy,
  setSortBy,
}: {
  issues: RetrievedIssue[];
  selectedSeverities: Set<string>;
  setSelectedSeverities: (s: Set<string>) => void;
  selectedPageTypes: Set<string>;
  setSelectedPageTypes: (s: Set<string>) => void;
  sortBy: "severity" | "confidence" | "none";
  setSortBy: (s: "severity" | "confidence" | "none") => void;
}) {
  const severities = Array.from(
    new Set(issues.map((i) => i.severity).filter((s): s is string => Boolean(s)))
  ).sort();

  const pageTypes = Array.from(
    new Set(issues.flatMap((i) => i.page_type ?? []))
  ).sort();

  const toggleSeverity = (severity: string) => {
    const newSet = new Set(selectedSeverities);
    if (newSet.has(severity)) {
      newSet.delete(severity);
    } else {
      newSet.add(severity);
    }
    setSelectedSeverities(newSet);
  };

  const togglePageType = (pageType: string) => {
    const newSet = new Set(selectedPageTypes);
    if (newSet.has(pageType)) {
      newSet.delete(pageType);
    } else {
      newSet.add(pageType);
    }
    setSelectedPageTypes(newSet);
  };

  const clearFilters = () => {
    setSelectedSeverities(new Set());
    setSelectedPageTypes(new Set());
    setSortBy("none");
  };

  const hasActiveFilters = selectedSeverities.size > 0 || selectedPageTypes.size > 0 || sortBy !== "none";

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
          Filter & Sort
        </p>
        {hasActiveFilters && (
          <button
            onClick={clearFilters}
            className="text-xs font-semibold text-emerald-700 hover:text-emerald-800"
          >
            Clear all
          </button>
        )}
      </div>

      {severities.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-600 mb-1.5">Severity</p>
          <div className="flex flex-wrap gap-2">
            {severities.map((severity) => (
              <label key={severity} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedSeverities.has(severity)}
                  onChange={() => toggleSeverity(severity)}
                  className="w-4 h-4"
                />
                <span className="text-xs text-slate-600">{severity}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {pageTypes.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-600 mb-1.5">Page Type</p>
          <div className="flex flex-wrap gap-2">
            {pageTypes.map((pageType) => (
              <label key={pageType} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedPageTypes.has(pageType)}
                  onChange={() => togglePageType(pageType)}
                  className="w-4 h-4"
                />
                <span className="text-xs text-slate-600">{pageType}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div>
        <p className="text-xs font-semibold text-slate-600 mb-1.5">Sort By</p>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as "severity" | "confidence" | "none")}
          className="w-full text-xs rounded border border-slate-300 bg-white px-2 py-1.5 text-slate-700 focus:border-emerald-500 focus:outline-none"
        >
          <option value="none">No sorting</option>
          <option value="severity">Severity (high to low)</option>
          <option value="confidence">Confidence (high to low)</option>
        </select>
      </div>
    </div>
  );
}

function ReportFeedbackBar({ reportId, url, siteType }: {
  reportId: string; url: string; siteType: string;
}) {
  const storageKey = `feedback:overall:${reportId}`;
  const [submitted, setSubmitted] = useState<1 | -1 | null>(() => {
    if (typeof window === "undefined") return null;
    const v = localStorage.getItem(storageKey);
    return v ? (Number(v) as 1 | -1) : null;
  });
  const [submitting, setSubmitting] = useState(false);

  const handleVote = async (signal: 1 | -1) => {
    if (submitted !== null || submitting) return;
    setSubmitting(true);
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          report_id: reportId, url, site_type: siteType,
          feedback_type: "overall",
          issue_id: null, issue_title: null,
          signal, confidence_score: null,
        }),
      });
      localStorage.setItem(storageKey, String(signal));
      setSubmitted(signal);
    } catch (e) {
      console.error("[ReportFeedbackBar]", e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-4 flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
      <span className="text-sm font-medium text-slate-600">Was this audit helpful?</span>
      {submitted !== null ? (
        <span className="text-sm font-semibold text-emerald-700">Thanks for your feedback 🙏</span>
      ) : (
        <div className="flex items-center gap-2">
          <button id="feedback-overall-up" type="button" onClick={() => handleVote(1)}
            disabled={submitting}
            className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 transition-all hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">
            👍 Helpful
          </button>
          <button id="feedback-overall-down" type="button" onClick={() => handleVote(-1)}
            disabled={submitting}
            className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 transition-all hover:border-rose-400 hover:bg-rose-50 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-50">
            👎 Not helpful
          </button>
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const [form, setForm] = useState(defaultForm);
  const [report, setReport] = useState<string>("");
  const [reportId, setReportId] = useState<string>("");
  const [siteType, setSiteType] = useState<string>("");
  const [retrievedIssues, setRetrievedIssues] = useState<RetrievedIssue[]>([]);
  const [totalEstimatedFixHours, setTotalEstimatedFixHours] = useState<number | null>(null);
  const [usedMock, setUsedMock] = useState<boolean>(false);
  const [usedModel, setUsedModel] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasSubmitted, setHasSubmitted] = useState<boolean>(false);
  const [isPending, startTransition] = useTransition();
  const [screenshots, setScreenshots] = useState<File[]>([]);
  const [selectedSeverities, setSelectedSeverities] = useState<Set<string>>(new Set());
  const [selectedPageTypes, setSelectedPageTypes] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<"severity" | "confidence" | "none">("none");

  const severityRank: { [key: string]: number } = {
    Critical: 0,
    Major: 1,
    High: 1,
    Moderate: 2,
    Medium: 2,
    Minor: 3,
    Low: 3,
  };

  const filteredAndSortedIssues = useMemo(() => {
    let result = [...retrievedIssues];

    // Apply severity filter
    if (selectedSeverities.size > 0) {
      result = result.filter((issue) =>
        issue.severity && selectedSeverities.has(issue.severity)
      );
    }

    // Apply page type filter
    if (selectedPageTypes.size > 0) {
      result = result.filter((issue) =>
        issue.page_type && issue.page_type.some((pt) => selectedPageTypes.has(pt))
      );
    }

    // Apply sorting
    if (sortBy === "severity") {
      result.sort((a, b) => {
        const rankA = a.severity ? (severityRank[a.severity] ?? 999) : 999;
        const rankB = b.severity ? (severityRank[b.severity] ?? 999) : 999;
        return rankA - rankB;
      });
    } else if (sortBy === "confidence") {
      result.sort((a, b) => {
        const confA = a.confidence_weight ?? 0;
        const confB = b.confidence_weight ?? 0;
        return confB - confA;
      });
    }

    return result;
  }, [retrievedIssues, selectedSeverities, selectedPageTypes, sortBy]);

  const handleDownloadDoc = () => {
    if (!report) return;
    const safeUrl =
      form.url
        ?.replace(/^https?:\/\//, "")
        .replace(/[^\w\-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "ux-audit";

    const markdownToHtml = (md: string) => {
      const lines = md.split(/\r?\n/);
      const out: string[] = [];
      let currentList: string[] = [];
      let listType: "ul" | "ol" | null = null;

      const flushList = () => {
        if (currentList.length > 0 && listType) {
          const tag = listType;
          out.push(`<${tag} style="margin:8px 0 12px 24px;">`);
          for (const item of currentList) {
            const htmlItem = item.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
            out.push(`<li style="margin-bottom:6px;">${htmlItem}</li>`);
          }
          out.push(`</${tag}>`);
          currentList = [];
          listType = null;
        }
      };

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          flushList();
          continue;
        }

        if (/^---+$/.test(line)) {
          flushList();
          out.push('<hr style="border:none;border-top:1px solid #ddd;margin:16px 0;"/>');
          continue;
        }

        if (line.startsWith("### ")) {
          flushList();
          const text = line.substring(4).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
          out.push(`<h3 style="font-family:Inter,system-ui,Arial,sans-serif;font-size:16px;margin:12px 0 8px;color:#0f172a;">${text}</h3>`);
          continue;
        }

        if (line.startsWith("## ")) {
          flushList();
          const text = line.substring(3).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
          out.push(`<h2 style="font-family:Inter,system-ui,Arial,sans-serif;font-size:18px;margin:14px 0 8px;color:#0f172a;">${text}</h2>`);
          continue;
        }

        if (line.startsWith("# ")) {
          flushList();
          const text = line.substring(2).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
          out.push(`<h1 style="font-family:Inter,system-ui,Arial,sans-serif;font-size:20px;margin:16px 0 10px;color:#0f172a;">${text}</h1>`);
          continue;
        }

        if (/^[-*]\s+/.test(line)) {
          if (listType !== "ul") {
            flushList();
            listType = "ul";
          }
          currentList.push(line.replace(/^[-*]\s+/, "").trim());
          continue;
        }

        if (/^\d+\.\s+/.test(line)) {
          if (listType !== "ol") {
            flushList();
            listType = "ol";
          }
          currentList.push(line.replace(/^\d+\.\s+/, "").trim());
          continue;
        }

        flushList();
        const paragraph = line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        out.push(`<p style="font-family:Inter,system-ui,Arial,sans-serif;font-size:14px;color:#1f2937;line-height:1.5;margin:8px 0;">${paragraph}</p>`);
      }

      flushList();
      return out.join("\n");
    };

    const html = `<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width,initial-scale=1">\n  <title>UX Audit Report</title>\n  <style>\n    body { font-family: Inter, system-ui, Arial, sans-serif; color: #0f172a; padding: 28px; }\n    strong { font-weight: 700; }\n  </style>\n</head>\n<body>\n${markdownToHtml(report)}\n</body>\n</html>`;

    const blob = new Blob([html], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeUrl}-ux-audit-report.doc`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleSubmit = () => {
    // Always generate a fresh ID — intentional reset per submission.
    // Use fallback for non-secure contexts (HTTP) where crypto.randomUUID is undefined
    const newReportId = (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") 
      ? crypto.randomUUID() 
      : `report-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    
    if (reportId) {
      Object.keys(localStorage)
        .filter((k) => k.startsWith(`feedback:overall:${reportId}`) || k.startsWith(`feedback:issue:${reportId}:`))
        .forEach((k) => localStorage.removeItem(k));
    }
    setReportId(newReportId);
    setError(null);
    setMessage(null);
    setReport("");
    setTotalEstimatedFixHours(null);
    setUsedModel(null);
    setHasSubmitted(true);
    setSelectedSeverities(new Set());
    setSelectedPageTypes(new Set());
    setSortBy("none");

    startTransition(async () => {
      const hasScreenshots = screenshots.length > 0;

      const res = await fetch(
        "/api/generate",
        hasScreenshots
          ? {
              method: "POST",
              body: (() => {
                const fd = new FormData();
                fd.append("url", form.url);
                fd.append("goal", form.goal);
                fd.append("model", form.model);
                fd.append("useCompany", String(form.useCompany));
                fd.append("topK", String(form.topK));
                for (const file of screenshots) {
                  fd.append("screenshots", file, file.name);
                }
                return fd;
              })(),
            }
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(form),
            },
      );

      let data: ApiResponse;
      try {
        data = await res.json(); // Attempt to parse JSON
      } catch (error) {
        setError("Failed to parse response."); // Handle JSON parsing error
        return; // Exit early
      }

      if (!res.ok || data.error) {
        setError(data.error ?? "Something went wrong.");
        return; // Exit early
      }

      setReport(data.report);
      setRetrievedIssues(data.retrievedIssues ?? []);
      setTotalEstimatedFixHours(
        typeof data.total_estimated_fix_hours === "number"
          ? data.total_estimated_fix_hours
          : null,
      );
      setUsedMock(Boolean(data.usedMock));
      setUsedModel(data.model ?? null);
      setSiteType((data as any).metadata?.siteType ?? "");
      setMessage(
        data.usedMock
          ? data.note ?? "Using sample report (no API key)."
          : "Live response via OpenRouter",
      );
    });
  };


  return (
    <div suppressHydrationWarning={true} className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
              AI-assisted UX audit generator
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-slate-900">
              Generate a first-draft UX audit from any URL
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Uses the company&apos;s UX issue library to avoid hallucinations.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <StatPill label="Input" value="URL + goal" />
              <StatPill label="Output" value="Journey-based draft report" />
              <StatPill label="Mode" value="With/without company knowledge" />
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Input
              </p>
              <h2 className="text-lg font-semibold text-slate-900">
                URL and goal to start
              </h2>
            </div>
            <button
              type="button"
              onClick={() => setForm(defaultForm)}
              className="text-xs font-semibold text-emerald-700 hover:text-emerald-800"
            >
              Reset to demo values
            </button>
          </div>

          <div className="mt-4 space-y-4">
            <div>
              <label className="text-sm font-semibold text-slate-800">
                Website URL
              </label>
              <input
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-emerald-500 focus:outline-none"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://"
                type="url"
              />
            </div>
            <div>
              <label className="text-sm font-semibold text-slate-800">
                Primary goal 
              </label>
              <textarea
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-emerald-500 focus:outline-none"
                value={form.goal}
                onChange={(e) => setForm({ ...form, goal: e.target.value })}
                rows={2}
              />
              <p className="mt-1 text-xs text-slate-500">
                After describing the audit goal (and entering a URL) the
                screenshot upload field will appear with instructions tailored
                to your goal. The guidance is shown in a larger, high‑contrast
                font so it&apos;s easy to notice.
              </p>
            </div>
            {form.url.trim().length > 0 && form.goal.trim().length > 0 ? (
              <div>
                <label className="text-sm font-semibold text-slate-800">
                  Optional screenshots (PNG/JPG/WebP)
                </label>
                {/** dynamic instruction based on goal */}
                <p className="mt-1 text-base font-semibold text-rose-800">
                  {getScreenshotInstruction(form.goal)}
                </p>
                <input
                  className="mt-2 block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-slate-800 hover:file:bg-slate-200"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    setScreenshots(files);
                  }}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {screenshots.length ? (
                    <>
                      <span className="text-xs font-semibold text-slate-600">
                        {screenshots.length} file(s) selected
                      </span>
                      <button
                        type="button"
                        onClick={() => setScreenshots([])}
                        className="text-xs font-semibold text-emerald-700 hover:text-emerald-800"
                      >
                        Clear
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-slate-500">
                      Leave empty to generate from URL + goal only.
                    </span>
                  )}
                </div>
              </div>
            ) : null}
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleSubmit}
                disabled={isPending}
                className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-emerald-600/20 transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isPending ? "Generating…" : "Generate report"}
              </button>
              {message ? (
                <span className="text-xs font-semibold text-emerald-700">
                  {message}
                </span>
              ) : null}
            </div>
            {error ? (
              <div className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                {error}
              </div>
            ) : null}
            {hasSubmitted ? (
              <div className="space-y-4 pt-6">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-sm font-semibold text-slate-800">
                      Model (via OpenRouter)
                    </label>
                    <input
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-emerald-500 focus:outline-none"
                      value={usedModel ?? "openrouter/auto"}
                      readOnly
                    />
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-slate-800">
                      Retrieved issues (top-k)
                    </label>
                    <input
                      className="mt-1 w-full cursor-pointer"
                      type="range"
                      min={5}
                      max={10}
                      value={form.topK}
                      onChange={(e) =>
                        setForm({ ...form, topK: Number(e.target.value) })
                      }
                    />
                    <p className="text-xs text-slate-500">
                      {form.topK} issue patterns passed as context
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-800">
                      Use company UX issue library
                    </p>
                    <p className="text-xs text-slate-500">
                      Grounds the audit in known, validated patterns.
                    </p>
                  </div>
                  <label className="relative inline-flex cursor-pointer items-center">
                    <input
                      type="checkbox"
                      className="peer sr-only"
                      checked={form.useCompany}
                      onChange={(e) =>
                        setForm({ ...form, useCompany: e.target.checked })
                      }
                    />
                    <div className="h-6 w-11 rounded-full bg-slate-300 transition peer-checked:bg-emerald-500" />
                    <span className="absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-5" />
                  </label>
                </div>
                <div className="flex flex-wrap gap-3 text-xs font-semibold text-slate-600">
                  <button
                    type="button"
                    onClick={() =>
                      setForm((prev) => ({
                        ...prev,
                        url: "https://in.bookmyshow.com/",
                        goal: "Improve booking conversion and reduce drop-offs",
                      }))
                    }
                    className="rounded-full border border-slate-200 bg-white px-3 py-1 hover:border-emerald-300 hover:text-emerald-700"
                  >
                    BookMyShow sample
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setForm((prev) => ({
                        ...prev,
                        url: "https://www.example.com/",
                        goal: "Understand friction on a generic e-commerce flow",
                      }))
                    }
                    className="rounded-full border border-slate-200 bg-white px-3 py-1 hover:border-emerald-300 hover:text-emerald-700"
                  >
                    Generic sample
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        {hasSubmitted ? (
          <div className="mt-6 grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Output
                  </p>
                  <h3 className="text-lg font-semibold text-slate-900">
                    Journey-based UX audit
                  </h3>
                  {usedMock && message ? (
                    <p className="text-xs font-semibold text-amber-700">
                      {message}
                    </p>
                  ) : null}
                  {!usedMock && usedModel ? (
                    <p className="text-xs text-slate-500">
                      Generated via <span className="font-semibold text-slate-700">{usedModel}</span> on OpenRouter.
                    </p>
                  ) : null}
                </div>
                {report ? (
                  <button
                    type="button"
                    onClick={handleDownloadDoc}
                    className="rounded-full border border-slate-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 shadow-sm hover:border-emerald-300 hover:bg-emerald-100"
                  >
                    Download DOC
                  </button>
                ) : null}
              </div>

              {!report && !isPending ? (
                <p className="mt-4 text-sm text-slate-500">
                  Run the generator to view the report. We render the AI output
                  with light formatting to keep it review-friendly for UX teams.
                </p>
              ) : null}

              {isPending ? (
                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                  Thinking with {form.useCompany ? "company" : "generic"} lens…
                </div>
              ) : null}

              {report ? (
                <div className="mt-4 space-y-4">
                  {retrievedIssues.length > 0 && form.useCompany ? (
                    <>
                      <SeverityDashboard issues={retrievedIssues} />
                      <SeverityLevelDashboard issues={retrievedIssues} />
                      {typeof totalEstimatedFixHours === "number" ? (
                        <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-slate-100 p-4">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-600 mb-2">
                            ESTIMATED TOTAL FIX TIME
                          </p>
                          <p className="text-3xl font-semibold text-slate-900">
                            {totalEstimatedFixHours} hours
                          </p>
                          <p className="mt-2 text-xs text-slate-500">
                            Based on summed estimated hours of final reported issues
                          </p>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-800">
                    <MarkdownRenderer content={report} />
                  </div>
                  <ReportFeedbackBar
                    reportId={reportId}
                    url={form.url}
                    siteType={siteType}
                  />
                </div>
              ) : null}
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Context
                  </p>
                  <h3 className="text-lg font-semibold text-slate-900">
                    Retrieved UX issue patterns
                  </h3>
                </div>
                <span className="text-xs font-semibold text-slate-500">
                  {filteredAndSortedIssues.length} of {retrievedIssues.length} issues
                </span>
              </div>
              {form.useCompany === false ? (
                <p className="mt-3 text-sm text-slate-600">
                  Company knowledge is toggled off. Turn it on to see the RAG
                  context used by the model.
                </p>
              ) : null}
              {retrievedIssues.length === 0 && form.useCompany ? (
                <p className="mt-3 text-sm text-slate-600">
                  Run the generator to view the retrieved patterns.
                </p>
              ) : null}
              {retrievedIssues.length > 0 && (
                <>
                  <div className="mt-4">
                    <FilterSort
                      issues={retrievedIssues}
                      selectedSeverities={selectedSeverities}
                      setSelectedSeverities={setSelectedSeverities}
                      selectedPageTypes={selectedPageTypes}
                      setSelectedPageTypes={setSelectedPageTypes}
                      sortBy={sortBy}
                      setSortBy={setSortBy}
                    />
                  </div>
                  <div className="mt-4 space-y-3">
                    {filteredAndSortedIssues.length > 0 ? (
                      filteredAndSortedIssues.map((issue) => (
                        <IssueCard
                          key={issue.issue_id ?? issue.issue_title ?? Math.random()}
                          issue={issue}
                          reportId={reportId}
                          url={form.url}
                          siteType={siteType}
                        />
                      ))
                    ) : (
                      <p className="text-sm text-slate-600 py-4 text-center">
                        No issues match your filters.
                      </p>
                    )}
                  </div>
                </>
              )}
            </section>
          </div>
        ) : null}
      </main>
    </div>
  );
}
