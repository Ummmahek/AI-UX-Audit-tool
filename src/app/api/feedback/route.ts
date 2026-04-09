import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";

export const runtime = "nodejs";

interface FeedbackBody {
  report_id: string;
  url?: string;
  site_type?: string;
  feedback_type: "overall" | "issue";
  issue_id?: string | null;
  issue_title?: string | null;
  signal: 1 | -1;
  confidence_score?: number | null;
}

export async function POST(request: Request) {
  try {
    const body: FeedbackBody = await request.json();

    // ── Validation ──────────────────────────────────────────────────────────
    if (!body.report_id || typeof body.report_id !== "string") {
      return NextResponse.json(
        { error: "report_id is required." },
        { status: 400 }
      );
    }

    if (body.signal !== 1 && body.signal !== -1) {
      return NextResponse.json(
        { error: "signal must be 1 (thumbs up) or -1 (thumbs down)." },
        { status: 400 }
      );
    }

    if (body.feedback_type !== "overall" && body.feedback_type !== "issue") {
      return NextResponse.json(
        { error: "feedback_type must be 'overall' or 'issue'." },
        { status: 400 }
      );
    }

    // ── Build document ───────────────────────────────────────────────────────
    const doc = {
      report_id: body.report_id,
      url: body.url ?? "",
      site_type: body.site_type ?? "",         // empty string allowed — no enum constraint
      feedback_type: body.feedback_type,
      issue_id: body.issue_id ?? null,
      issue_title: body.issue_title ?? null,
      signal: body.signal,
      confidence_score: body.confidence_score ?? null,
      created_at: new Date(),
    };

    // ── Persist ──────────────────────────────────────────────────────────────
    const db = await getDb();
    await db.collection("feedback_events").insertOne(doc);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[/api/feedback] Error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
