// URL → job source detection (PRD 01 §2 story 3, §6 "No SSRF", §7 "URL → source detection").
// Only Greenhouse, Lever and Ashby job links are accepted; the API URL is always built by our code
// on a fixed host, never taken from what the user sent.
import { describe, expect, it } from "vitest";
import { ALLOWED_API_HOSTS } from "../../src/sources/safe-fetch.js";
import { CANT_READ_SITE, NOT_ONE_JOB, detectJobSource } from "../../src/sources/job-url.js";

function detected(input: string) {
  const result = detectJobSource(input);
  if (!result.ok) throw new Error(`expected a source, got: ${result.message}`);
  return result.source;
}

function rejected(input: string): string {
  const result = detectJobSource(input);
  if (result.ok) throw new Error(`expected a rejection, got ${result.source.kind}`);
  return result.message;
}

describe("detectJobSource — Greenhouse", () => {
  const expected = {
    kind: "greenhouse",
    sourceUrl: "https://job-boards.greenhouse.io/acme/jobs/4012345678",
    apiUrl: "https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345678?pay_transparency=true",
    slug: "acme",
    jobId: "4012345678",
  };

  it.each([
    "https://job-boards.greenhouse.io/acme/jobs/4012345678",
    "https://boards.greenhouse.io/acme/jobs/4012345678",
    "https://boards.greenhouse.io/acme/jobs/4012345678/",
    "https://boards.greenhouse.io/acme/jobs/4012345678?gh_src=linkedin#app",
    "http://boards.greenhouse.io/acme/jobs/4012345678",
    "HTTPS://Boards.Greenhouse.IO/acme/jobs/4012345678",
    "  https://job-boards.greenhouse.io/acme/jobs/4012345678  ",
    "https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345678",
    "https://job-boards.greenhouse.io/embed/job_app?token=4012345678&for=acme",
  ])("reads %s", (url) => {
    expect(detected(url)).toEqual(expected);
  });
});

describe("detectJobSource — Lever", () => {
  const id = "5f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5";

  it.each([
    `https://jobs.lever.co/northwind/${id}`,
    `https://jobs.lever.co/northwind/${id}/`,
    `https://jobs.lever.co/northwind/${id}/apply`,
    `https://jobs.lever.co/northwind/${id}?lever-source=LinkedIn`,
    `https://jobs.lever.co/northwind/${id.toUpperCase()}`,
  ])("reads %s", (url) => {
    expect(detected(url)).toEqual({
      kind: "lever",
      sourceUrl: `https://jobs.lever.co/northwind/${id}`,
      apiUrl: `https://api.lever.co/v0/postings/northwind/${id}`,
      slug: "northwind",
      jobId: id,
    });
  });

  it("reads an EU Lever link through the EU API host", () => {
    expect(detected(`https://jobs.eu.lever.co/northwind/${id}`)).toEqual({
      kind: "lever",
      sourceUrl: `https://jobs.eu.lever.co/northwind/${id}`,
      apiUrl: `https://api.eu.lever.co/v0/postings/northwind/${id}`,
      slug: "northwind",
      jobId: id,
    });
  });
});

describe("detectJobSource — Ashby", () => {
  const id = "2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091";

  it.each([
    `https://jobs.ashbyhq.com/lumenworks/${id}`,
    `https://jobs.ashbyhq.com/lumenworks/${id}/application`,
    `https://jobs.ashbyhq.com/lumenworks/${id}?utm_source=x`,
    `https://jobs.ashbyhq.com/lumenworks/${id.toUpperCase()}/`,
  ])("reads %s", (url) => {
    expect(detected(url)).toEqual({
      kind: "ashby",
      sourceUrl: `https://jobs.ashbyhq.com/lumenworks/${id}`,
      apiUrl: "https://api.ashbyhq.com/posting-api/job-board/lumenworks?includeCompensation=true",
      slug: "lumenworks",
      jobId: id,
    });
  });

  it("keeps a dot in an organisation name (some Ashby boards are named after their domain)", () => {
    expect(detected(`https://jobs.ashbyhq.com/acme.com/${id}`).apiUrl).toBe(
      "https://api.ashbyhq.com/posting-api/job-board/acme.com?includeCompensation=true",
    );
  });
});

describe("detectJobSource — anything else gets the paste message", () => {
  it("uses the PRD's wording", () => {
    expect(CANT_READ_SITE).toBe("I can't read that site; paste the job description text.");
  });

  it.each([
    "https://www.linkedin.com/jobs/view/1234567890",
    "https://www.indeed.com/viewjob?jk=abc123",
    "https://careers.acme.com/jobs/123?gh_jid=4012345678",
    "https://acme.com/careers?ashby_jid=2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091",
    "https://job-boards.eu.greenhouse.io/acme/jobs/4012345678",
    "https://boards.greenhouse.io.evil.example/acme/jobs/4012345678",
    "https://evilgreenhouse.io/acme/jobs/4012345678",
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345678",
    "https://api.lever.co/v0/postings/northwind/5f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:5432/",
    "http://127.0.0.1/acme/jobs/1",
    "ftp://boards.greenhouse.io/acme/jobs/4012345678",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "boards.greenhouse.io/acme/jobs/4012345678",
    "not a link at all",
    "",
    "   ",
  ])("rejects %j", (input) => {
    expect(rejected(input)).toBe(CANT_READ_SITE);
  });

  it("rejects a link longer than 2,000 characters", () => {
    expect(rejected(`https://boards.greenhouse.io/acme/jobs/1?x=${"a".repeat(2_000)}`)).toBe(CANT_READ_SITE);
  });
});

describe("detectJobSource — a supported site, but not one job", () => {
  it.each([
    "https://boards.greenhouse.io/acme",
    "https://job-boards.greenhouse.io/acme/jobs",
    "https://boards.greenhouse.io/acme/jobs/not-a-number",
    "https://boards.greenhouse.io/embed/job_board?for=acme",
    "https://boards.greenhouse.io/embed/job_app?for=acme",
    "https://jobs.lever.co/northwind",
    "https://jobs.lever.co/northwind/not-a-uuid",
    "https://jobs.ashbyhq.com/lumenworks",
    "https://jobs.ashbyhq.com/lumenworks/2b3c4d5e",
    "https://jobs.lever.co/",
  ])("says so for %s", (url) => {
    expect(rejected(url)).toBe(NOT_ONE_JOB);
  });

  it("asks for the job's own link or the pasted text", () => {
    expect(NOT_ONE_JOB).toBe(
      "That link is a list of jobs, not one job. Open the job and copy its link, or paste the job description text.",
    );
  });
});

describe("detectJobSource — the fetched address is built by code (no SSRF)", () => {
  it.each([
    // Path tricks in the company part must not change the API path or host.
    "https://boards.greenhouse.io/..%2F..%2Fadmin/jobs/1",
    "https://boards.greenhouse.io/%2e%2e/jobs/1",
    "https://jobs.lever.co/a%2Fb/5f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5",
    "https://jobs.ashbyhq.com/../2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091",
    "https://jobs.ashbyhq.com/a@b/2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091",
    "https://boards.greenhouse.io/embed/job_app?for=evil.example%2F&token=1",
  ])("refuses an odd company name in %s", (url) => {
    expect(detectJobSource(url).ok).toBe(false);
  });

  it("ignores a user name, password or port in the link", () => {
    const source = detected("https://user:pass@boards.greenhouse.io:8443/acme/jobs/4012345678");
    expect(source.apiUrl).toBe("https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345678?pay_transparency=true");
    expect(source.sourceUrl).toBe("https://job-boards.greenhouse.io/acme/jobs/4012345678");
  });

  it("every API URL it builds is HTTPS on an allowlisted host", () => {
    const links = [
      "https://boards.greenhouse.io/acme/jobs/1",
      "https://jobs.lever.co/n/5f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5",
      "https://jobs.eu.lever.co/n/5f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5",
      "https://jobs.ashbyhq.com/l/2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091",
    ];
    for (const link of links) {
      const api = new URL(detected(link).apiUrl);
      expect(api.protocol).toBe("https:");
      expect(ALLOWED_API_HOSTS).toContain(api.hostname);
      expect(api.port).toBe("");
      expect(api.username).toBe("");
    }
  });
});

describe("detectJobSource — one stored link per job, whatever the case or zero padding", () => {
  it("Greenhouse: board name lowercased and leading zeros dropped, in the stored link AND the API call", () => {
    // Greenhouse's API answers the same job for any board-name case and for a zero-padded id
    // (checked against the live API on 2026-11-19).
    const a = detected("https://boards.greenhouse.io/Acme/jobs/0012");
    const b = detected("https://boards.greenhouse.io/acme/jobs/12");
    expect(a.sourceUrl).toBe("https://job-boards.greenhouse.io/acme/jobs/12");
    expect(a.sourceUrl).toBe(b.sourceUrl);
    expect(a.apiUrl).toBe("https://boards-api.greenhouse.io/v1/boards/acme/jobs/12?pay_transparency=true");
    expect(a.jobId).toBe("12");
  });

  it("Greenhouse embed links normalise the same way", () => {
    expect(detected("https://boards.greenhouse.io/embed/job_app?for=ACME&token=007").sourceUrl).toBe(
      "https://job-boards.greenhouse.io/acme/jobs/7",
    );
  });

  it("Greenhouse: an all-zero id stays one zero", () => {
    expect(detected("https://boards.greenhouse.io/acme/jobs/000").jobId).toBe("0");
  });

  it("Lever: stored link lowercased, but the API is called with the name as linked (Lever is case-sensitive)", () => {
    const id = "5f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5";
    const a = detected(`https://jobs.lever.co/NorthWind/${id}`);
    expect(a.sourceUrl).toBe(`https://jobs.lever.co/northwind/${id}`);
    expect(a.sourceUrl).toBe(detected(`https://jobs.lever.co/northwind/${id}`).sourceUrl);
    expect(a.apiUrl).toBe(`https://api.lever.co/v0/postings/NorthWind/${id}`);
    expect(detected(`https://jobs.eu.lever.co/NorthWind/${id}`).sourceUrl).toBe(`https://jobs.eu.lever.co/northwind/${id}`);
  });

  it("Ashby: org name lowercased in the stored link and the API call (Ashby ignores case)", () => {
    const id = "2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091";
    const a = detected(`https://jobs.ashbyhq.com/LumenWorks/${id}`);
    expect(a.sourceUrl).toBe(`https://jobs.ashbyhq.com/lumenworks/${id}`);
    expect(a.sourceUrl).toBe(detected(`https://jobs.ashbyhq.com/lumenworks/${id}`).sourceUrl);
    expect(a.apiUrl).toBe("https://api.ashbyhq.com/posting-api/job-board/lumenworks?includeCompensation=true");
  });
});
