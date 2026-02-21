## AI-assisted UX audit generator (Next.js demo)

Input: website URL + goal. Output: a journey-based first-draft UX audit. The demo can ground the reasoning in the company’s UX Issue Library (copied from the Streamlit prototype) or run a generic heuristic pass.

### What’s inside
- Next.js App Router + TypeScript + Tailwind
- API route `/api/generate` that calls OpenAI’s Responses API (or a sample report if no key is set)
- Simple keyword retrieval over a UX issue library JSON (default: `src/data/ux_issue_library_ecommerce_v1.json`)
- Presentation-first UI to compare “with vs without company knowledge”

### Replacing the UX issue library
To use a different JSON library:

1. **Option A – Same folder**  
   Put your file in `src/data/` (e.g. `src/data/my_library.json`). Then in `src/lib/ux.ts` change `DEFAULT_LIBRARY_FILE` to your filename:
   ```ts
   const DEFAULT_LIBRARY_FILE = "my_library.json";
   ```

2. **Option B – Env variable**  
   Set `UX_ISSUE_LIBRARY` to the path to your JSON file (relative to project root or absolute):
   ```bash
   # .env.local
   UX_ISSUE_LIBRARY=src/data/my_library.json
   ```
   or
   ```bash
   UX_ISSUE_LIBRARY=/absolute/path/to/your_library.json
   ```

Your JSON must be either:
- an **array** of issue objects, or  
- an **object** with one of these keys containing the array: `issues`, `data`, or `items`.

Each issue object should include at least: `issue_title`, `user_problem`, `recommendation`; optional: `page_type`, `signals_to_detect`, `confidence_weight`, `issue_id`, etc. (see `Issue` in `src/lib/ux.ts`).

### Requirements
- Node.js **>= 20.9.0** (Next.js 16 requires this; current machine is on 18.x)
- `OPENAI_API_KEY` in a `.env.local` file to fetch live reports; without it the UI returns a sample response.

### Quick start
```bash
npm install
# add OPENAI_API_KEY=sk-*** to .env.local
npm run dev
```
Then open http://localhost:3000.

### Demo flow
1) Enter URL and primary goal.  
2) Choose model and top-k issue patterns.  
3) Toggle “Use company UX issue library” on/off to compare grounded vs generic audits.  
4) Retrieved patterns and the generated report render side by side.

### Pending (future work)
- Real detection logic: read DOM/rendered HTML, detect signals (CTAs, pricing blocks, trust cues), and map to the issue library.
- Export/history/auth for a productized frontend.
