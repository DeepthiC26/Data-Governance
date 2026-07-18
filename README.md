# Data Governance

A single-file, browser-based data-analysis and AI-governance tool. Upload any CSV
or Excel file and it automatically cleans it, analyzes it, runs a small machine-
learning pipeline, answers questions about it in plain English, and rates how much
you can trust the result — with an optional layer where **Claude Opus independently
reviews the analysis** before you act on it.

**The entire website is one file — `data-governance.html`.** No server, no
install, no build step. Just open it in a browser. Your data never leaves your
machine.

---

## Table of contents
1. [What it is](#what-it-is)
2. [Quick start](#quick-start)
3. [The dashboard views](#the-dashboard-views)
4. [How the analysis works & why it's trustworthy](#how-it-works)
5. [The Data Governance score](#the-speed-governance-score)
6. [The optional AI features](#the-optional-ai-features)
7. [How to get an OpenRouter API key (step by step)](#how-to-get-an-api-key)
8. [Troubleshooting](#troubleshooting)
9. [Privacy & offline use](#privacy)
10. [Limitations (honest notes)](#limitations)

---

<a name="what-it-is"></a>
## 1. What it is

The **actual data analysis uses no AI model at all.** Every number — statistics,
correlations, trends, machine-learning results, and the governance score — is
computed by plain, deterministic code running in your browser. That is what makes
the numbers trustworthy: arithmetic can't hallucinate.

Two Anthropic models are used only as an **optional layer on top**:

- **Claude Sonnet** — writes a readable narrative *around* the numbers the code
  already computed (the "Analyst").
- **Claude Opus** — independently *reviews* that work for correctness and trust
  (the "Reviewer").

Even then, the app re-checks the AI against its own math, so the models never
become the source of the numbers.

**In one line:** *code computes and verifies everything; the LLMs only explain and
review on top.*

---

<a name="quick-start"></a>
## 2. Quick start

1. **Open the app.** Double-click `data-governance.html` so it opens in a real
   browser tab (the address bar should read `file:///…/data-governance.html`).
   Chrome or Edge recommended.
   > Do **not** run it inside an embedded preview pane — sandboxes there block
   > file downloads and outbound API calls.
2. **Load data.** Click **Choose file** (CSV / TSV / TXT / XLSX / XLS) or
   **Use sample data** to try it instantly.
3. **Explore the sidebar views** (see below). Everything except the AI features
   works fully offline.
4. *(Optional)* Turn on the AI features by adding an OpenRouter API key —
   see [section 7](#how-to-get-an-api-key).

---

<a name="the-dashboard-views"></a>
## 3. The dashboard views

| View | What it does |
|------|--------------|
| **Overview** | Dataset summary + the Data Governance confidence gauge. |
| **Transform** | Automatic cleaning: type inference, currency/percent/date parsing, duplicate removal, missing-value imputation, outlier flags — with a full operations log. |
| **Insights** | Auto-generated insights and trends. |
| **Visualizations** | Auto-selected charts (distribution, category breakdown, trend, correlation heatmap, missing-data). |
| **ML pipeline** | K-means++ clustering (chosen by silhouette score), PCA projection, linear-regression forecast (with R²/MAPE), and anomaly detection (modified z-score / MAD). |
| **Analytics chat** | Ask questions in plain English — totals, averages, filters ("how many over 60"), group comparisons, correlations, feature importance. Answers are **computed**, not guessed. |
| **Governance** | The Data Governance confidence score (0–100) broken into seven signals. |
| **Opus Review** | Claude Opus independently reviews Sonnet's analysis and produces a Review Report, a Score Card, and a combined Final Data Governance Score. |

---

<a name="how-it-works"></a>
## 4. How the analysis works & why it's trustworthy

When you upload a file it flows through a fixed, deterministic pipeline:

- **Type inference & cleaning** — each column is classified (numeric, categorical,
  date, boolean, text) by how its values parse. Cleaning strips currency/percent
  symbols, parses dates, removes exact duplicate rows, imputes missing values
  (median for numeric, mode for categorical), and flags outliers.
- **Statistics & relationships** — standard descriptive stats; **Pearson
  correlation** between numeric columns; linear trend over time; group-by
  aggregations for category breakdowns.
- **Analytics chat** — a deterministic natural-language-to-query engine. It parses
  your question into an intent (aggregate, filter, group comparison, correlation,
  feature importance…) using your real column names, then runs that computation. It
  can't invent a number, but it also can't reason beyond your columns (for that,
  use AI mode).
- **ML pipeline** — classic, well-understood algorithms: **K-means++** (cluster
  count chosen by **silhouette score**), **PCA** for a 2-D view, **linear
  regression** forecasting reported with **R²/MAPE**, and anomaly detection via the
  **modified z-score (median absolute deviation)**.

Because all of this is pure computation, the same file always produces the same
result — it's reproducible and inspectable.

---

<a name="the-speed-governance-score"></a>
## 5. The Data Governance score

A transparent, reproducible **0–100 rating of data reliability** — a weighted mean
of seven signals about the data itself:

1. **Completeness** — how little is missing.
2. **Validity** — how much parsed cleanly to its type.
3. **Uniqueness** — duplication / constant-column penalties.
4. **Type clarity** — how unambiguous the schema is.
5. **Stability** — consistency across the data.
6. **Robustness** — sensitivity to outliers.
7. **Richness** — enough rows/columns to say anything meaningful.

A **small-sample cap** stops a tiny dataset from scoring "highly reliable." Bands:
**≥85 Reliable · 70–84 Moderate · 50–69 Guarded · <50 Low.**

**What it means:** it answers *"is this data solid enough to analyze?"* — **not**
*"is my business conclusion true?"* Clean, complete data can still be biased or
mis-framed. That second question is exactly why the Opus Review layer exists.

---

<a name="the-optional-ai-features"></a>
## 6. The optional AI features

Two features can call an LLM, and both are optional:

- **Analytics-chat "AI mode"** — answers open-ended questions conversationally,
  grounded in the numbers the app computed.
- **Opus Review** — Claude Opus reviews Sonnet's analysis and produces a Review
  Report, a Score Card, and a **Final Data Governance Score** that blends Sonnet's
  original score with Opus's trust score.

Both call **OpenRouter** (a service that gives one API key access to many AI
models) directly from your browser. **They require your own OpenRouter API key.**

Importantly, the **Opus Review re-verifies Sonnet's numbers with the deterministic
engine first**, so its Accuracy metric is anchored to real re-computation — not the
model's opinion. If Opus can't be reached, the app still gives you a real,
locally-computed review; you just don't get the AI's written narrative.

---

<a name="how-to-get-an-api-key"></a>
## 7. How to get an OpenRouter API key (step by step)

You only need this for the optional AI features. It takes a few minutes.

### Step 1 — Create an account
1. Go to **<https://openrouter.ai>**.
2. Click **Sign in** (top right) and register — you can sign up with Google,
   GitHub, or email.

### Step 2 — Add credit
The AI features cost money per call (usually a fraction of a cent), so your account
needs a balance or calls fail with `HTTP 402 – requires more credits`.
1. Click your avatar (top right) → **Credits** (or go to
   <https://openrouter.ai/settings/credits>).
2. Click **Add Credits** and pay with a card. **$5 is far more than enough** for
   many reviews.

### Step 3 — Create the API key
1. Go to **<https://openrouter.ai/keys>** (avatar → **Keys**).
2. Click **Create Key**, give it a name (e.g. "speed-governance"), and click
   **Create**.
3. **Copy the key immediately** — it looks like `sk-or-v1-xxxxxxxx…`. You won't be
   able to see it again (you can always create a new one).

### Step 4 — Use the key in the app
1. Open the app in a real browser tab.
2. For the **Opus Review**: go to the **Opus Review** view, paste the key into the
   **OpenRouter API key** field.
3. Click **Test connection** — it should say **CONNECTED**. Then click **Run Opus
   review**.
4. For **AI chat mode**: open the chat's settings, choose provider **OpenRouter**,
   paste the key, and pick a model.

### Which model to use
The app defaults to current Anthropic models on OpenRouter:
- Analyst — `anthropic/claude-sonnet-4.6`
- Reviewer — `anthropic/claude-opus-4.8`

You can type any model ID OpenRouter offers into the model field. Browse them at
**<https://openrouter.ai/models>**. Opus is the most capable (and priciest);
Sonnet is cheaper and faster.

> **Model IDs change over time.** If you get `404 – No endpoints found`, that
> version was retired — check <https://openrouter.ai/anthropic> for the current
> name and paste it into the model field.

> **Never share or commit your API key.** It's tied to your billing. The app
> stores it only in the page while open; it is never saved into the code.

---

<a name="troubleshooting"></a>
## 8. Troubleshooting

| Message / symptom | Meaning & fix |
|-------------------|---------------|
| `HTTP 402 … requires more credits` | Your OpenRouter account has no balance — add credit (Step 2 above). |
| `404 – No endpoints found` | The model ID was retired — use a current one from openrouter.ai. |
| `Failed to fetch` | You're in a sandboxed preview, offline, or behind a firewall/ad-blocker — open the file in a real browser tab and check your connection. |
| `401 / 403` | The API key is invalid — recreate it (Step 3). |
| Stuck on the landing page | Make sure you clicked **Choose file** or **Use sample data**; open in a real browser tab. |
| The AI review shows "LOCAL REVIEW" | Opus was unreachable, so you got the deterministic review instead. Fix the key/credit/connection and Run again for the full AI narrative. |

Tip: the **Test connection** button on the Opus Review page tells you exactly which
of these is the problem before you run.

---

<a name="privacy"></a>
## 9. Privacy & offline use

- CSV parsing, all analysis, ML, chat, governance, and the deterministic review run
  **entirely in your browser** — your data is never uploaded.
- Only the **optional** AI features send data (the dataset's schema/summary and your
  question) to OpenRouter, and only when you provide a key.
- Chart rendering (Plotly) and Excel reading (SheetJS) load small libraries from a
  CDN, so a first run online is smoother; CSV analysis works fully offline.

---

<a name="limitations"></a>
## 10. Limitations (honest notes)

- The governance score measures **data reliability**, not whether a conclusion is
  correct — clean data can still be biased or mis-framed.
- The offline chat answers **computable** questions; open-ended reasoning ("why did
  sales drop?") needs AI mode.
- The AI narrative/review requires a real browser tab, internet, and an OpenRouter
  key **with credit**. Without those, the deterministic results still stand on
  their own.
