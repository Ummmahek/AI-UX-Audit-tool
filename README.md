## AI-assisted UX audit generator (Next.js demo)

Input: website URL + goal. Output: a journey-based first-draft UX audit. The demo can ground the response in the company’s UX Issue Library (from the Streamlit prototype) or run a generic heuristic audit.

## What’s included
- Next.js App Router + TypeScript + Tailwind CSS
- API route `/api/generate` that uses OpenAI Responses API for live audit generation
- Sample fallback response when no AI key is configured
- Keyword retrieval from a UX issue library JSON
- UI to compare “with company library” vs “generic audit”

## Requirements for any local system
1. Node.js **20.9.0 or newer**
2. npm (or a compatible package manager)
3. A local copy of this repository
4. An OpenAI/open router/ any other AI API key set as `OPENAI_API_KEY` in `.env.local`

> This project depends on the AI API for live generation. Without `OPENAI_API_KEY`, the app still launches, but it will show a sample audit instead of calling OpenAI.

## Recommended local setup
1. Clone or copy the repository to your machine.
2. Open a terminal in the project root.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Create a `.env.local` file in the project root.
5. Add your AI API key:
   ```bash
   OPENAI_API_KEY=sk-...
   ```
6. Start the development server:
   ```bash
   npm run dev
   ```
7. Open the app in your browser:
   ```bash
   http://localhost:3000
   ```

## Environment variables
- `OPENAI_API_KEY` — required for live OpenAI calls
- `UX_ISSUE_LIBRARY` —  path to a custom UX issue library JSON file

Example `.env.local`:
```bash
OPENAI_API_KEY=sk-...
UX_ISSUE_LIBRARY=src/data/ux_issue_library_v4.3_COMPLETE.json
```

## Optional: Playwright crawler setup
If you want the crawler functionality for JavaScript-rendered sites, install browser binaries after dependencies:

```bash
npm install playwright-extra
npx playwright install
```

Note: there is a `postinstall` script in `package.json` that should install Playwright browsers automatically when running `npm install`.

## Running on another local machine
1. Ensure Node.js version is `>= 20.9.0`.
2. Install repo dependencies with `npm install`.
3. Create `.env.local` and set `OPENAI_API_KEY`.
4. (Optional) Set `UX_ISSUE_LIBRARY` if you want a custom library file.
5. Run `npm run dev`.
6. Visit `http://localhost:3000`.

## Using a custom UX issue library
### Option A — Put the file in `src/data/`
1. Copy your JSON file to `src/data/`.
2. Update `DEFAULT_LIBRARY_FILE` in `src/lib/ux.ts`:
   ```ts
   const DEFAULT_LIBRARY_FILE = "my_library.json";
   ```

### Option B — Use `UX_ISSUE_LIBRARY`
Set the env var to the relative or absolute path:
```bash
UX_ISSUE_LIBRARY=src/data/my_library.json
```
or
```bash
UX_ISSUE_LIBRARY=C:/full/path/to/my_library.json
```

## JSON library format
Your JSON library must be either:
- an array of issue objects, or
- an object with one of these keys containing the array: `issues`, `data`, or `items`

Each issue object should include at least:
- `issue_title`
- `user_problem`
- `recommendation`

Optional fields:
- `page_type`
- `signals_to_detect`
- `confidence_weight`
- `issue_id`

For details, see the `Issue` type in `src/lib/ux.ts`.

## Quick start summary
```bash
npm install
# create .env.local with OPENAI_API_KEY
npm run dev
```

Then open `http://localhost:3000`.

## Demo flow
1. Enter a URL and a primary goal.
2. Choose model and top-k issue patterns.
3. Toggle “Use company UX issue library” on/off.
4. Compare grounded vs generic audit output.

## Notes
- `OPENAI_API_KEY` is required for live AI generation.
- If the key is missing, the app falls back to a sample report.
- Playwright is optional and only needed for crawling JS-rendered targets.
