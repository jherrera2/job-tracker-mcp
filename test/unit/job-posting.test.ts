// Pay ranges as a posting states them (PRD 01 §2 story 3: "pay if posted").
import { describe, expect, it } from "vitest";
import { formatRange } from "../../src/sources/job-posting.js";

describe("formatRange", () => {
  it("formats a range", () => {
    expect(formatRange(150_000, 185_000, "USD")).toBe("150,000–185,000 USD");
  });

  it("says 'from' when only the minimum is given", () => {
    expect(formatRange(150_000, null, "USD")).toBe("from 150,000 USD");
  });

  it("says 'up to' when only the maximum is given", () => {
    expect(formatRange(undefined, 185_000, "USD")).toBe("up to 185,000 USD");
  });

  it("gives one figure when both ends are the same", () => {
    expect(formatRange(150_000, 150_000, "USD")).toBe("150,000 USD");
  });

  it("keeps the source's precision instead of rounding to 2 decimals", () => {
    expect(formatRange(12.345, null, "BHD")).toBe("from 12.345 BHD");
    expect(formatRange(12.345, 12.349, "BHD")).toBe("12.345–12.349 BHD");
    expect(formatRange(19.99, 24.5, "USD")).toBe("19.99–24.5 USD");
  });

  it("only shows one figure when the two ends really are equal", () => {
    expect(formatRange(10.001, 10.004, "KWD")).toBe("10.001–10.004 KWD");
  });

  it("is null with neither end, and works without a currency", () => {
    expect(formatRange(null, null, "USD")).toBeNull();
    expect(formatRange(12.5, 20)).toBe("12.5–20");
  });
});
