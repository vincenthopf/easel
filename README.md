# Easel

![Easel](docs/assets/hero.png)

Easel is a read-only Canvas CLI for deadlines, marks, modules, announcements, discussions, course pages, downloadable files, and public library material. It is designed for people and automation that need compact, deterministic output without giving a study agent permission to change academic records.

## Requirements

- Node.js 20, 22, or 24
- macOS, Linux, or Windows
- A personal Canvas access token for Canvas commands
- No Canvas credential for `bug` or public library commands

## Install

Install a reviewed release from npm:

```sh
npm install --global @vincenthopf/easel@<version>
easel --version
```

The repository `setup.sh` installs only an exact release. It does not install Homebrew, execute remote shell scripts, or choose an unreviewed package version:

```sh
EASEL_VERSION=<version> ./setup.sh
```

## Set up

Interactive setup hides token input and verifies the configured Canvas origin before replacing the user config:

```sh
easel init
```

For automation, use a complete URL/token pair. The token can come from a protected environment variable or standard input, never a command-line token flag:

```sh
CANVAS_TOKEN="$CANVAS_TOKEN" easel init \
  --canvas-url https://canvas.example.edu

printf '%s' "$CANVAS_TOKEN" | easel init \
  --canvas-url https://canvas.example.edu \
  --token-stdin
```

Use `--replace-host` for a deliberate non-interactive Canvas host change. Use `--no-verify` only when the profile endpoint cannot be reached and the origin has been checked independently.

## Configuration model

`CANVAS_BASE_URL` and `CANVAS_TOKEN` are one credential record. Easel never fills one field from a lower-priority source.

| Priority | Source | Acceptance rule |
| --- | --- | --- |
| 1 | Process environment | Both Canvas values must be present |
| 2 | Current-directory `.env` | `EASEL_PROJECT_CONFIG=1` must be set in the process environment and both values must be present |
| 3 | Native user config | Both values must be present |

A partial higher-priority record fails with an actionable error. For Canvas commands, a current-directory file containing Canvas settings also fails unless project configuration is explicitly enabled. Non-Canvas commands ignore project Canvas credentials unless that opt-in is present. This prevents an untrusted directory from redirecting a token stored in the user config.

Project-local Canvas configuration is disabled by default. To opt in for one invocation:

```sh
EASEL_PROJECT_CONFIG=1 easel whoami
```

Review the project `.env` before enabling it. Do not commit tokens.

### Native paths

| Platform | User config | Cache and rate state |
| --- | --- | --- |
| macOS | `~/Library/Application Support/easel/.env` | `~/Library/Caches/easel` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/easel/.env` | `${XDG_CACHE_HOME:-~/.cache}/easel` |
| Windows | `%APPDATA%\easel\.env` | `%LOCALAPPDATA%\easel\cache` |

`EASEL_CONFIG_DIR` and `EASEL_CACHE_DIR` provide explicit overrides. Easel creates private configuration and state directories and writes secret-bearing files with restrictive permissions where the operating system supports POSIX modes.

On macOS and Windows, Easel reads the prior `~/.config/easel/.env` location when the native config file does not yet exist. Running `easel init` shows that saved host and writes the verified record to the native path, so migration cannot silently switch Canvas origins.

### Configuration variables

```dotenv
CANVAS_BASE_URL=https://canvas.example.edu
CANVAS_TOKEN=replace-with-a-personal-access-token
LIBRARY_BASE_URL=https://library.example.edu

EASEL_REQUEST_TIMEOUT_MS=15000
EASEL_RETRY_LIMIT=2
EASEL_MAX_REDIRECTS=4
EASEL_MAX_PAGES=100
EASEL_MAX_ITEMS=10000
EASEL_MAX_RESPONSE_BYTES=10485760
EASEL_MAX_DOWNLOAD_BYTES=524288000
EASEL_LOCK_TIMEOUT_MS=10000

EASEL_MIN_INTERVAL=0.7
EASEL_MAX_INTERVAL=1.8
EASEL_RPM=40
```

`EASEL_ALLOW_INSECURE_LOCALHOST=1` permits HTTP only for localhost development. It does not permit HTTP Canvas or library hosts elsewhere.

## Credential and request boundaries

Canvas authorization is sent only to the exact configured Canvas origin. Easel rejects:

- absolute Canvas API URLs on another origin
- cross-origin pagination links
- cross-origin authenticated redirects
- HTTPS-to-HTTP redirects
- URLs containing embedded credentials

Canvas redirects are handled manually and validated before another request is made. Public library requests and signed file downloads use a separate client that cannot inherit the Canvas token. Signed query strings and token material are removed from error messages.

Every request has a deadline. Retries, redirect count, response bytes, pagination pages, pagination items, lock waits, and download bytes are bounded. Timeouts and pagination failures are errors; they are never converted into empty results.

## Read-only contract

Easel sends `GET` requests to Canvas. It does not submit assignments, post discussions, alter grades, mark items complete, change enrolments, or write to Canvas. Local writes are limited to:

- the explicit user configuration created by `easel init`
- scoped cache and rate-limit state
- explicit text exports
- explicit file downloads
- update-check state

Local state uses atomic replacement. Course and rate state are scoped with an opaque origin-and-credential fingerprint, so switching hosts or accounts does not reuse another account's state. The token itself is never written into a path or log.

## Commands

```text
easel today
easel due [--days 14] [--course BIO101]
easel marks [--course BIO101]
easel courses [--all]
easel modules BIO101
easel page BIO101 page-slug [--objective topic] [--full] [-o page.txt]
easel announcements [--course BIO101]
easel discussions BIO101
easel files [BIO101]
easel pull 11111/33333 [-o brief.pdf] [--overwrite]
easel whoami
easel library search "referencing"
easel library fetch https://library.example.edu/guide
easel bug
easel init
```

Course codes must be exact or unambiguous. An ambiguous prefix fails and lists safe choices instead of selecting the first course.

`today` and missing-submission output distinguish authentication and permission errors from an empty academic result. A Canvas instance that lacks the endpoint produces an unsupported-feature error.

## JSON output

Commands support oclif JSON output:

```sh
easel due --json
easel marks --json
easel whoami --json
```

Update notices are disabled in JSON and non-interactive execution, so standard output remains machine-readable. File-discovery JSON no longer exposes verifier values or signed query strings. It returns `hasVerifier`, a `courseId/fileId` reference, and a query-free URL instead.

## Downloads and exports

`easel pull` authenticates only the same-origin Canvas metadata request. The returned signed file URL is fetched without the Canvas token, streamed to a private temporary file, size-checked, synchronized, and committed atomically.

An explicit `-o` path is not overwritten unless `--overwrite` is supplied. Automatic names avoid collisions. Names are sanitized for Windows reserved names, control characters, forbidden separators, and trailing dots or spaces.

Text exports also avoid overwriting an existing path. Easel chooses a numbered filename and reports the final path.

## Public library support

Library support is generic. Set `LIBRARY_BASE_URL` to the institution's public library or guide site. Easel tries common public search routes and falls back to extracting useful links from returned HTML. It does not send unexplained Springshare source or site identifiers and never sends a Canvas token.

## Grade estimates

Canvas grading semantics are richer than a local points calculation. Easel therefore:

- prefers the current score reported by Canvas when available
- labels local calculations as simple weighted or points estimates
- excludes excused and omitted assignments
- avoids claiming a locked-in result when drop rules exist
- reports limitations for drop rules, grading periods, late policies, unpublished adjustments, and manual overrides

The JSON keys `currentGrade` and `finalLockedIn` remain for compatibility. `basis` and `limitations` explain what can and cannot be inferred. Treat every projection as study planning data, not an official grade determination.

## Development

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:artifact
pnpm package:smoke
```

Tests use local mock servers and deterministic fixtures. They do not require real Canvas credentials or network access. CI validates Node 20, 22, and 24 on Ubuntu, then installs and exercises the packed CLI on Ubuntu, macOS, and Windows.

Release publishing runs the same validation and packed-install checks on the exact `main` commit. npm trusted publishing is restricted to the publish job, uses GitHub OIDC, and pins the npm CLI version required for that path.

## Security reports and bugs

Run:

```sh
easel bug
```

Do not include Canvas tokens, signed URLs, course names, downloaded files, or personal data in reports.
