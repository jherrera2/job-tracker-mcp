// The demo data for `npm run db:seed` (PRD 01 §8 step 9): one FICTIONAL job seeker, so anyone can
// try the tools in minutes. Riley Example is not a real person, and every company, school and
// posting below is invented; any likeness to a real business is a coincidence.
//
// The fit answers stand in for what the user's own chat model would write (ADR-001). They are
// stored through the real save_fit tool (src/demo/seed.ts), so they pass the same shape check and
// the same word-for-word quote check, and their scores are computed by the same code. Every
// evidence_quote below is copied exactly from DEMO_RESUME (test/unit/demo-data.test.ts checks it).
import type { JobStatus } from "../db/lookups.js";
import type { CriterionInput } from "../domain/criteria.js";

/** What the fit check stores as the (self-reported) model, so a demo fit is never mistaken for a real one. */
export const DEMO_MODEL = "demo data (hand-written, not a model)";

export const DEMO_RESUME = `# Riley Example

_Fictional demo résumé for job-tracker-mcp: not a real person. Every company and school below is invented._

Product Data Analyst · Remote, US · riley.example@example.com

## Summary

Data analyst with 7 years of experience turning messy product and sales data into decisions. Strong in SQL, Python and dashboard design; comfortable owning a metric from its definition to the weekly review.

## Experience

### Senior Data Analyst, Glowworm Commerce (2021–present)
- Built the company's first SQL data model for orders and returns, used by 40 people across finance and support.
- Designed and analyzed 30+ A/B tests on checkout and onboarding, lifting checkout conversion by 6%.
- Wrote Python scripts that automated the weekly revenue report, saving the finance team 5 hours a week.
- Ran a monthly metrics review with product managers and presented findings to the leadership team.
- Mentored two junior analysts through their first year.

### Data Analyst, Harborlight Insurance Services (2018–2021)
- Built Tableau dashboards for claims volume and handling time, adopted by 12 regional managers.
- Cleaned and joined data from three legacy systems into one reporting table in PostgreSQL.
- Partnered with operations to cut average claim handling time by 9 days.

### Reporting Assistant, Maple Row Credit Union (2017–2018)
- Prepared monthly member-growth reports in Excel for the board.

## Skills
- SQL (PostgreSQL, BigQuery), Python (pandas), dbt
- Tableau, Looker
- A/B testing and experiment design
- Stakeholder communication

## Education
- B.S. in Statistics, Lakeshore State University (2017)
`;

/** Riley's top 5, in their own words (PRD §2 story 2). */
export const DEMO_CRITERIA: readonly CriterionInput[] = [
  { label: "Pay floor", detail: "Base pay of at least $110k." },
  { label: "Fully remote", detail: "Remote anywhere in the US; I won't relocate." },
  { label: "No weekends or on-call", detail: "No regular weekend work and no pager duty." },
  { label: "Room to grow", detail: "A team where I can get better at data modelling and experimentation." },
  { label: "Company size", detail: "Between 50 and 1,000 people." },
];

/** The answer save_fit takes (src/domain/fit-result.ts); validated there, not here. */
export interface DemoFitAnswer {
  requirements: { text: string; status: "met" | "partial" | "missing"; evidence_quote?: string }[];
  criteria: { label: string; status: "met" | "unclear" | "not_met"; reason: string }[];
  red_flags: string[];
  recommendation: "go" | "maybe" | "skip";
  summary: string;
}

export interface DemoJob {
  title: string;
  company: string;
  /** The pasted job description (the seed never fetches a link). */
  text: string;
  fit: DemoFitAnswer;
  /** Status moves after "saved", in order, made with set_status. */
  moves: readonly { status: JobStatus; note?: string }[];
}

export const DEMO_JOBS: readonly DemoJob[] = [
  {
    title: "Senior Product Analyst",
    company: "Glimmerfin Outfitters",
    text: `Senior Product Analyst, Glimmerfin Outfitters
(Glimmerfin Outfitters is a fictional company, made up for this demo.)

Remote (US) · $120,000 – $140,000 base · about 400 people

Glimmerfin sells outdoor gear online. Our product team ships changes to search, checkout and the
mobile app every week, and we want a senior analyst to make sure every change is measured.

What you'll do
- Own the metrics for checkout and the mobile app, from definition to weekly review.
- Design A/B tests with product managers and explain the results to leadership.
- Build models in our dbt project on top of BigQuery.

What we're looking for
- 5+ years of analytics experience with SQL
- Hands-on A/B testing experience
- Python for analysis and automation
- Confident presenting to executives
- Experience with dbt

Normal business hours. No on-call. A yearly learning budget and a mentor in the data team.
`,
    fit: {
      requirements: [
        { text: "5+ years of analytics experience with SQL", status: "met", evidence_quote: "Data analyst with 7 years of experience" },
        {
          text: "Hands-on A/B testing experience",
          status: "met",
          evidence_quote: "Designed and analyzed 30+ A/B tests on checkout and onboarding, lifting checkout conversion by 6%.",
        },
        {
          text: "Python for analysis and automation",
          status: "met",
          evidence_quote: "Wrote Python scripts that automated the weekly revenue report",
        },
        {
          text: "Confident presenting to executives",
          status: "met",
          evidence_quote: "presented findings to the leadership team",
        },
        {
          text: "Experience with dbt",
          status: "partial",
          evidence_quote: "Built the company's first SQL data model for orders and returns",
        },
      ],
      criteria: [
        { label: "Pay floor", status: "met", reason: "The range starts at $120,000, above the $110k floor." },
        { label: "Fully remote", status: "met", reason: "The posting says remote in the US." },
        { label: "No weekends or on-call", status: "met", reason: "Normal business hours, and it says no on-call." },
        { label: "Room to grow", status: "met", reason: "dbt modelling and experiment design, plus a learning budget and a mentor." },
        { label: "Company size", status: "met", reason: "About 400 people." },
      ],
      red_flags: [],
      recommendation: "go",
      summary: "A strong match on SQL, experiments and Python; dbt is the only thing to learn, and every criterion is met.",
    },
    moves: [
      { status: "go", note: "Best match so far." },
      { status: "applied", note: "Applied on their careers page." },
    ],
  },
  {
    title: "Analytics Engineer",
    company: "Quillfeather Learning",
    text: `Analytics Engineer, Quillfeather Learning
(Quillfeather Learning is a fictional company, made up for this demo.)

Remote (US) · $105,000 – $125,000 · 120 people

Quillfeather makes reading apps for schools. We're looking for our second analytics engineer to
help us turn raw app events into clean, tested tables that teachers and staff can trust.

Requirements
- dbt in production: models, tests and documentation
- Expert SQL
- Orchestrating pipelines with Airflow
- Software engineering habits: git, code review, CI
- Python

You'll take part in a light on-call rotation for the data pipelines (one week in six).
We pair every new hire with a senior engineer for their first three months.
`,
    fit: {
      requirements: [
        {
          text: "dbt in production: models, tests and documentation",
          status: "partial",
          evidence_quote: "Built the company's first SQL data model for orders and returns, used by 40 people across finance and support.",
        },
        { text: "Expert SQL", status: "met", evidence_quote: "SQL (PostgreSQL, BigQuery)" },
        { text: "Orchestrating pipelines with Airflow", status: "missing" },
        { text: "Software engineering habits: git, code review, CI", status: "missing" },
        { text: "Python", status: "met", evidence_quote: "Python (pandas)" },
      ],
      criteria: [
        { label: "Pay floor", status: "unclear", reason: "The range starts below $110k and tops out above it." },
        { label: "Fully remote", status: "met", reason: "Remote in the US." },
        { label: "No weekends or on-call", status: "not_met", reason: "There is an on-call rotation, one week in six." },
        { label: "Room to grow", status: "met", reason: "A senior engineer pairs with new hires; it is mostly data modelling." },
        { label: "Company size", status: "met", reason: "120 people." },
      ],
      red_flags: ["On-call rotation for the data pipelines."],
      recommendation: "maybe",
      summary: "Half the requirements are engineering skills not on the résumé yet, and the on-call rotation breaks a criterion.",
    },
    moves: [],
  },
  {
    title: "Data Analyst, Player Insights",
    company: "Lanternfish Games",
    text: `Data Analyst, Player Insights, Lanternfish Games
(Lanternfish Games is a fictional company, made up for this demo.)

Remote (US) · $115,000 – $135,000 · 300 people

Lanternfish makes cosy multiplayer games. The Player Insights team studies how people play so the
designers can make the games more fun.

You have
- Experience with game telemetry or other high-volume event data
- Strong SQL
- Experience with Unity or Unreal event pipelines
- A solid grounding in experiment design

Some weekend support is expected during big game launches (about four weekends a year).
Analysts here get a learning budget and time to learn the game engines.
`,
    fit: {
      requirements: [
        { text: "Experience with game telemetry or other high-volume event data", status: "missing" },
        { text: "Strong SQL", status: "met", evidence_quote: "SQL (PostgreSQL, BigQuery)" },
        { text: "Experience with Unity or Unreal event pipelines", status: "missing" },
        { text: "A solid grounding in experiment design", status: "partial", evidence_quote: "A/B testing and experiment design" },
      ],
      criteria: [
        { label: "Pay floor", status: "met", reason: "The range starts at $115,000." },
        { label: "Fully remote", status: "met", reason: "Remote in the US." },
        { label: "No weekends or on-call", status: "not_met", reason: "About four launch weekends a year." },
        { label: "Room to grow", status: "met", reason: "A learning budget and time to learn the game engines." },
        { label: "Company size", status: "met", reason: "300 people." },
      ],
      red_flags: ["Weekend work during launches."],
      recommendation: "go",
      summary: "A stretch on the game-specific requirements, but the team and terms fit; worth applying.",
    },
    moves: [{ status: "go", note: "A stretch, but I love the studio." }],
  },
  {
    title: "Business Intelligence Lead",
    company: "Copperkettle Freight",
    text: `Business Intelligence Lead, Copperkettle Freight
(Copperkettle Freight is a fictional company, made up for this demo.)

On-site in Denver, CO, five days a week · $130,000 base · 2,500 people

Copperkettle moves freight across the western US. We need a lead to run our reporting team and
our Power BI platform.

Requirements
- 8+ years in business intelligence
- Managing a team of four analysts
- Power BI administration
- On-site in Denver five days a week
- SQL

The BI lead is part of the on-call rotation for the reporting platform.
`,
    fit: {
      requirements: [
        { text: "8+ years in business intelligence", status: "partial", evidence_quote: "Data analyst with 7 years of experience" },
        {
          text: "Managing a team of four analysts",
          status: "partial",
          evidence_quote: "Mentored two junior analysts through their first year.",
        },
        { text: "Power BI administration", status: "missing" },
        { text: "On-site in Denver five days a week", status: "missing" },
        { text: "SQL", status: "met", evidence_quote: "SQL (PostgreSQL, BigQuery)" },
      ],
      criteria: [
        { label: "Pay floor", status: "met", reason: "$130,000 base." },
        { label: "Fully remote", status: "not_met", reason: "On-site in Denver five days a week." },
        { label: "No weekends or on-call", status: "not_met", reason: "The lead is on the on-call rotation." },
        { label: "Room to grow", status: "unclear", reason: "A step up into management, but nothing about learning." },
        { label: "Company size", status: "not_met", reason: "2,500 people." },
      ],
      red_flags: ["Fully on-site.", "On-call rotation."],
      recommendation: "skip",
      summary: "On-site five days a week and on-call, at a company far bigger than the target; skip.",
    },
    moves: [{ status: "skip", note: "On-site five days a week in Denver, and far bigger than I want." }],
  },
  {
    title: "Marketing Data Analyst",
    company: "Pebblestone Pet Supply",
    text: `Marketing Data Analyst, Pebblestone Pet Supply
(Pebblestone Pet Supply is a fictional company, made up for this demo.)

Hybrid: two days a week in our Portland, OR office · $95,000 – $105,000 · 180 people

Pebblestone sells pet food and toys online and in 30 stores. Our marketing team needs an analyst
to tell them which campaigns work.

What you bring
- Strong SQL
- Building dashboards in Looker
- Marketing attribution and campaign measurement
- Presenting findings to non-technical stakeholders
- Advanced Excel

Office hours Monday to Friday; no on-call.
`,
    fit: {
      requirements: [
        { text: "Strong SQL", status: "met", evidence_quote: "SQL (PostgreSQL, BigQuery)" },
        { text: "Building dashboards in Looker", status: "met", evidence_quote: "Tableau, Looker" },
        { text: "Marketing attribution and campaign measurement", status: "missing" },
        {
          text: "Presenting findings to non-technical stakeholders",
          status: "met",
          evidence_quote: "Ran a monthly metrics review with product managers and presented findings to the leadership team.",
        },
        { text: "Advanced Excel", status: "met", evidence_quote: "Prepared monthly member-growth reports in Excel for the board." },
      ],
      criteria: [
        { label: "Pay floor", status: "not_met", reason: "The range tops out at $105,000, under the $110k floor." },
        { label: "Fully remote", status: "not_met", reason: "Hybrid, two days a week in Portland." },
        { label: "No weekends or on-call", status: "met", reason: "Monday to Friday, no on-call." },
        { label: "Room to grow", status: "unclear", reason: "The posting says nothing about learning or mentoring." },
        { label: "Company size", status: "met", reason: "180 people." },
      ],
      red_flags: [],
      recommendation: "maybe",
      summary: "The skills fit well, but the pay is under the floor and it isn't remote.",
    },
    moves: [],
  },
];
