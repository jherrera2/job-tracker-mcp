# ADR-003: Job sources — fixed ATS allowlist + paste fallback

- **Status:** Accepted
- **Date:** 2026-11-16

## Context
- Users want to add a job by link. Fetching any URL a user (or a model) supplies is a server-side request forgery (SSRF) risk.
- Greenhouse, Lever and Ashby publish public JSON APIs for job postings.
- LinkedIn and Indeed pages are not reliably fetchable and are out of scope for v1.

## Options considered
1. **Fetch any URL** and extract the posting from HTML.
2. **Fixed allowlist** of ATS API hosts, plus **paste the text** for everything else.

## Decision
Option 2. Only `boards-api.greenhouse.io`, `api.lever.co`, `api.eu.lever.co` and `api.ashbyhq.com` are fetched: HTTPS only, no user-supplied host, at most 3 same-host redirects, 10 s timeout, 2 MB cap (8 MB for Ashby, whose API returns the whole board). Anything else is pasted (200–50,000 characters).

## Why
- **Security.** If the server fetched any URL, someone could trick it into reaching places it shouldn't, such as internal networks or private addresses (SSRF).
- **Reliable data.** Greenhouse, Lever and Ashby have clean public APIs, so the posting comes back structured instead of scraped from HTML.
- **The big boards block it anyway.** LinkedIn and Indeed block automated fetching.
- **Nothing is left out.** Pasting always works, for any job from anywhere.

## Consequences
- A LinkedIn or Indeed link doesn't work; the user copies and pastes the text, an extra step that is easy to do incompletely.
- Supporting another job board (Workday, SmartRecruiters…) means writing a new adapter in code.
- Pasted jobs have no reliable company, title or pay fields unless the user adds them.

Security is always worth more.
