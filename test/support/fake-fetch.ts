// A stand-in for the global `fetch`, so no test ever touches the network (PRD 01 §7: "recorded ATS
// fixtures, no live network in CI"). It answers from a fixed table of URL → response and records
// every call, so a test can also prove that NO request was made.
import { readFileSync } from "node:fs";
import type { FetchFn } from "../../src/sources/safe-fetch.js";

export interface FakeRoute {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

export interface FakeFetch {
  fetch: FetchFn;
  /** Every URL requested, in order. */
  calls: string[];
  /** The `init` passed with each call, in order. */
  inits: RequestInit[];
}

/** Answers each request from `routes` (exact URL match); anything else is a 404. */
export function fakeFetch(routes: Record<string, FakeRoute>): FakeFetch {
  const calls: string[] = [];
  const inits: RequestInit[] = [];
  const fetch: FetchFn = (url, init) => {
    calls.push(url);
    inits.push(init);
    const route = routes[url];
    if (!route) return Promise.resolve(new Response("Not found", { status: 404 }));
    return Promise.resolve(
      new Response(route.body ?? "", {
        status: route.status ?? 200,
        headers: { "content-type": "application/json", ...route.headers },
      }),
    );
  };
  return { fetch, calls, inits };
}

/** A recorded ATS API response from test/fixtures/ats/ (fictional companies and people). */
export function atsFixture(name: "greenhouse-job" | "lever-posting" | "ashby-job-board"): string {
  return readFileSync(new URL(`../fixtures/ats/${name}.json`, import.meta.url), "utf8");
}

// The API URLs the fixtures stand for (built from the job links used in the tests).
export const GREENHOUSE_API_URL =
  "https://boards-api.greenhouse.io/v1/boards/peachtreeanalytics/jobs/4012345678?pay_transparency=true";
export const LEVER_API_URL = "https://api.lever.co/v0/postings/northwindlabs/5f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5";
export const ASHBY_API_URL = "https://api.ashbyhq.com/posting-api/job-board/lumenworks?includeCompensation=true";

export const GREENHOUSE_JOB_URL = "https://job-boards.greenhouse.io/peachtreeanalytics/jobs/4012345678";
export const LEVER_JOB_URL = "https://jobs.lever.co/northwindlabs/5f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5";
export const ASHBY_JOB_URL = "https://jobs.ashbyhq.com/lumenworks/2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091";

/** All three fixtures, served at their API URLs. */
export function fakeAtsFetch(): FakeFetch {
  return fakeFetch({
    [GREENHOUSE_API_URL]: { body: atsFixture("greenhouse-job") },
    [LEVER_API_URL]: { body: atsFixture("lever-posting") },
    [ASHBY_API_URL]: { body: atsFixture("ashby-job-board") },
  });
}
