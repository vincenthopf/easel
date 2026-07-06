<p align="center">
  <img src="docs/assets/hero.png" alt="easel — a calmer front door to Canvas" width="100%">
</p>

<h1 align="center">easel</h1>

<p align="center">
  <em>A read-only, context-lean command line for Canvas — built for study, and for the agents that help you study.</em>
</p>

---

`easel` turns Canvas into something you can actually live in from the terminal: deadlines, marks, module
content, announcements, discussions, embedded PDFs, and your library — as compact text a human can scan,
or lean JSON a Claude Code agent can read.

It is **read-only by design.** It only ever asks Canvas for information; it can never submit work, take a
quiz, post, or change anything in your account. That is enforced in the code — the HTTP client exposes
`GET` only — not just promised in a README.

```
$ easel today
Due soon
  Fri, 12 Sep, 12:00 pm · 9d · ABC101 · Assignment 2 · PROCTORED hands-off
Missing
  no missing submissions reported
Announcements
  03 Sep, 10:00 am · XYZ200 · Week 5 lecture notes are up
  02 Sep, 09:00 am · ABC101 · Drop-in help session this week

$ easel marks
ABC101 · 75.0% current grade (graded so far) · 15.0% of final locked in
XYZ200 · 68.0% current grade (graded so far) · 10.0% of final locked in
ABC101 · Quiz 1        · 15/20 · 75.0% · pass
XYZ200 · Assignment 1  · 17/25 · 68.0% · pass
```

> Illustrative output — subjects and figures are placeholders.

## Install

**Quick install (macOS)** — installs Node.js if you don't have it, installs easel, and runs the setup
wizard, all in one go:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/vincenthopf/easel/main/setup.sh)"
```

**Manual** — requires **Node.js 20+**, then install globally so the `easel` command is on your PATH:

```bash
npm install -g @vincenthopf/easel
# or: pnpm add -g @vincenthopf/easel
```

Check it worked:

```bash
easel --version   # → @vincenthopf/easel/x.y.z
```

<details>
<summary>Run from source instead</summary>

```bash
git clone https://github.com/vincenthopf/easel.git && cd easel
pnpm install && pnpm build
node dist/entry.js --version
```
</details>

## Get started

Run the wizard once:

```bash
easel init
```

It asks for three things and checks them for you:

1. **Canvas URL** — your institution's Canvas host, e.g. `https://canvas.youruniversity.edu`
2. **Access token** — Canvas → **Account → Settings → New Access Token** (create one, copy it)
3. **Library URL** *(optional)* — for `easel library`, e.g. `https://library.youruniversity.edu`

It saves everything to a private file at **`~/.config/easel/.env`** (permissions `600`) and confirms the
token works by greeting you by name. Because the config lives in your home folder, `easel` then runs from
**any directory**. Re-run `easel init` anytime to update a value (it pre-fills what you have, token masked).

Then you're off:

```bash
easel whoami        # confirm the account
easel today         # today's briefing
```

<details>
<summary>Prefer to configure by hand?</summary>

Set environment variables, or drop a `.env` in the folder you run `easel` from:

```ini
CANVAS_BASE_URL=https://canvas.youruniversity.edu   # your Canvas host
CANVAS_TOKEN=your-token-here
# Optional, for `easel library`:
LIBRARY_BASE_URL=https://library.youruniversity.edu
# Optional rate-limit tuning:
# EASEL_MIN_INTERVAL=0.7
# EASEL_MAX_INTERVAL=1.8
# EASEL_RPM=40
```

Precedence (first wins): real environment variables, then a `.env` in the current folder, then
`~/.config/easel/.env`.
</details>

Your token stays local and is sent only to your own Canvas host. The tool reads only *your* data — the
token can't see anyone else's.

## Commands

| Command | What it does |
| --- | --- |
| `easel init` | Interactive setup: save your Canvas URL, token and library |
| `easel today` | Briefing: what's genuinely outstanding, missing work, recent announcements |
| `easel due [--days N] [--course C]` | Upcoming assignments, sorted; submitted items marked done, proctored items flagged |
| `easel marks [--course C]` | Per-assessment scores, 50% pass-line read, and the graded-so-far current grade |
| `easel courses [--all]` | Your real subjects (admin shells hidden unless `--all`) |
| `easel modules <course>` | Module list and the page slugs inside them |
| `easel page <course> <slug>` | One module page as clean text |
| `easel announcements [--course C]` | Recent announcements across subjects |
| `easel discussions <course>` | Discussion forums for a subject |
| `easel files <course>` | Every downloadable file link embedded in briefs, pages and announcements |
| `easel pull <course/fileId>` | Resolve a Canvas file and download it (e.g. an assessment brief PDF) |
| `easel library search "<q>"` | Search your public library guides — no login |
| `easel library fetch <url>` | Pull one public library page as clean text |
| `easel bug` | How (and where) to report a bug |
| `easel whoami` | The account behind the token |

`<course>` accepts a subject code (e.g. `BIO101`) or a numeric Canvas id.

## Context-lean by default

Modelled on [`escli`](https://www.npmjs.com/package/@eightstate/escli): output stays small unless you ask
for more. On any content command:

- **compact** by default — one line per item, essentials only
- `--full` — the whole thing
- `--objective "<focus>"` — return only the passages relevant to a topic
- `-o <file>` — write full content to a file and print just a summary line (path · bytes · title)
- `--json` — lean, shaped DTOs (not raw Canvas blobs), for agents

## Rate limiting

Every request — Canvas and library alike — is paced like a human: a randomised gap between calls and a
hard ceiling per minute, **shared across all invocations on the machine** through a lock and state file.
`429` and `403 "rate limit exceeded"` responses back off exponentially with jitter. An agent hammering
`easel` in a loop still can't flood your institution's servers.

Tune it in `.env`: `EASEL_MIN_INTERVAL`, `EASEL_MAX_INTERVAL`, `EASEL_RPM`.

## For agents

If you're an agent using this tool: output is designed for you (`--json` everywhere). If you hit a bug,
wrong output, or a missing capability, **report it at https://vjh.io/bugreport** so it can be fixed fast.
`easel` will also tell you when a newer version is available and how to update.

## Where the lines are

Fine, by design: reading your own data to organise, understand and plan your study.

Not built, on purpose: anything that writes to Canvas, anything that operates during a proctored
(Respondus/webcam) assessment, per-question quiz review, and Canvas conversation/planner/calendar writes.
The clean test for any future feature: *would you be comfortable declaring this use to your tutor?*

## Not yet: the browser engine

Reading lists and other external LTI tabs (library databases, online-class tools) aren't Canvas data —
they need an authenticated browser session rather than a Canvas API call. That's a planned second phase
(a separate, human-paced browser engine), deliberately kept out of the read-only HTTP client for now.

## License

MIT.
