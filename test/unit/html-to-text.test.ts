// HTML job descriptions → plain text (PRD 01 §2 story 3: "description (plain text)").
import { describe, expect, it } from "vitest";
import { cleanDecodedLine, cleanLine, cleanText, decodeEntities, htmlToText, truncateChars } from "../../src/sources/html-to-text.js";

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities", () => {
    expect(decodeEntities("Node &amp; TS &lt;3 &quot;hi&quot; &#39;x&#39; &#x2014; &rsquo;&nbsp;&hellip;")).toBe(
      "Node & TS <3 \"hi\" 'x' — ’\u00a0…",
    );
  });

  it("decodes only once (&amp;lt; stays as the text &lt;)", () => {
    expect(decodeEntities("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
  });

  it("leaves unknown entities alone and turns invalid code points into U+FFFD (the HTML rule)", () => {
    expect(decodeEntities("&madeup; &#xFFFFFFF; &#0;")).toBe("&madeup; \uFFFD \uFFFD");
  });

  it("is case-sensitive, like HTML: &Eacute; is É, &eacute; is é, &EACUTE; is not an entity", () => {
    expect(decodeEntities("&Eacute; &eacute; &EACUTE;")).toBe("É é &EACUTE;");
  });

  it("knows the whole HTML entity table, not a hand-picked few", () => {
    expect(decodeEntities("M&uuml;nchen, Espa&ntilde;a, &Aring;s, &szlig;, &frac12;, &rarr;")).toBe(
      "München, España, Ås, ß, ½, →",
    );
  });

  it("needs the semicolon, so text like a URL query isn't mangled", () => {
    expect(decodeEntities("?a=1&para=2 &copyright")).toBe("?a=1&para=2 &copyright");
  });
});

describe("htmlToText", () => {
  it("turns paragraphs, headings and line breaks into lines", () => {
    expect(htmlToText("<h2>About</h2><p>We build tools.</p><p>Line one<br>line two<br/>three</p>")).toBe(
      "About\n\nWe build tools.\n\nLine one\nline two\nthree",
    );
  });

  it("turns list items into '- ' lines", () => {
    expect(htmlToText("<p>You will:</p><ul><li>Build APIs</li><li>Write <strong>tests</strong></li></ul>")).toBe(
      "You will:\n\n- Build APIs\n- Write tests",
    );
  });

  it("drops scripts, styles and comments with their contents", () => {
    expect(htmlToText("<p>Hi</p><script>alert('x')</script><style>p{}</style><!-- secret -->")).toBe("Hi");
  });

  it("keeps text that only looks like HTML once decoded (it is data, not markup)", () => {
    expect(htmlToText("<p>SQL &lt;joins&gt; &amp; a &lt; b</p>")).toBe("SQL <joins> & a < b");
  });

  it("collapses blank space but keeps paragraph breaks", () => {
    expect(htmlToText("<div>  lots   of\t space&nbsp;here </div>\n\n\n<div>next</div>")).toBe(
      "lots of space here\n\nnext",
    );
  });

  it("keeps the text of an attribute-heavy tag and drops the attributes", () => {
    expect(htmlToText('<a href="https://x.example" onclick="evil()">benefits</a> and pay')).toBe("benefits and pay");
  });
});

describe("htmlToText — unfinished markup", () => {
  it("keeps a '<' that never closes as text", () => {
    expect(htmlToText("<p>a <b>b</b> <a href=x")).toBe("a b <a href=x");
  });

  it("drops an unclosed script or comment to the end, as a browser would", () => {
    expect(htmlToText("<p>kept</p><script>alert(1)")).toBe("kept");
    expect(htmlToText("<p>kept</p><!-- never closed <p>hidden</p>")).toBe("kept");
  });

  it("takes a script's end tag in any case", () => {
    expect(htmlToText("<SCRIPT>x</ScRiPt >after")).toBe("after");
  });
});

describe("htmlToText — quoted attribute values", () => {
  it("a '>' inside a quoted attribute does not end the tag", () => {
    expect(htmlToText('<a title="x > y">benefits</a> and pay')).toBe("benefits and pay");
    expect(htmlToText("<a title='x > y'>benefits</a> and pay")).toBe("benefits and pay");
    expect(htmlToText('<img alt = "a>b" src=x>after')).toBe("after");
  });

  it("a quote that never closes: the tag ends at its first '>' (the old rule), the rest is still read as HTML", () => {
    expect(htmlToText('<p>kept</p><a title="never closed>more text')).toBe("kept\n\nmore text");
  });

  it("an unclosed quote does not expose later scripts, styles or comments as text", () => {
    expect(
      htmlToText('<p class="intro>Hello</p><script>SECRET_JS</script><style>p{}</style><!-- HIDDEN --><p>end</p>'),
    ).toBe("Hello\n\nend");
  });

  it("an apostrophe in an unquoted spot is not a quote", () => {
    expect(htmlToText("<p class=x don't>text</p>")).toBe("text");
  });
});

describe("htmlToText — a bare '<' in text", () => {
  it("is kept", () => {
    expect(htmlToText("<p>salary < 200k</p><p>3 <= 4 and 5 < 6</p>")).toBe("salary < 200k\n\n3 <= 4 and 5 < 6");
  });
});

describe("htmlToText — runs in linear time (no regex backtracking on hostile input)", () => {
  // The fetch timeout can't interrupt synchronous code, so a quadratic pattern on a 2 MB body
  // (8 MB for Ashby) would block the whole server. Each input is ~2 MB of unfinished markup.
  const MB2 = 2 * 1024 * 1024;
  it.each([
    ["unclosed <a", "<a"],
    ["unclosed <a with a space", "<a "],
    ["unclosed <script>", "<script>"],
    ["unclosed comment", "<!--"],
    ["unclosed <li", "<li"],
    ["unclosed </", "</"],
    ["entity starts", "&a"],
    ["unclosed double-quoted attribute", '<a b="'],
    ["unclosed single-quoted attribute", "<a b='"],
    ["quoted '>' that never ends the tag", '<a b="x>'],
    ["attribute '=' with no value", "<a b= "],
  ])("%s, repeated to 2 MB, finishes well under a second", (_name, unit) => {
    const input = unit.repeat(Math.ceil(MB2 / unit.length));
    const start = performance.now();
    htmlToText(input);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

describe("htmlToText — 8 MB of unclosed quotes (Ashby's cap) stays linear", () => {
  const MB8 = 8 * 1024 * 1024;
  it.each([
    ["one unclosed quote, then many tags", (n: number) => `<p class="x>${"<a b=c>d".repeat(n / 8)}`],
    ["many tags, then one unclosed quote", (n: number) => `${"<a b=c>d".repeat(n / 8)}<p class="x>`],
    ["both quote kinds unclosed", (n: number) => `<p a="x><p b='y>${"<i>t</i>".repeat(n / 8)}`],
    ["quotes that pair across tags", (n: number) => '<a b="x>'.repeat(n / 8)],
  ])("%s", (_name, build) => {
    const input = build(MB8);
    const start = performance.now();
    htmlToText(input);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

describe("htmlToText — memory stays flat on many bare '<'", () => {
  // Copilot (PR #4): each bare "<" used to add two pieces to an internal array, so 8 MB of "<"
  // meant ~16 million entries. Count every Array.prototype.push during the call (V8's own
  // builtins never go through the patched method, so only our code is counted).
  it.each([
    ["8 MB of '<'", "<".repeat(8 * 1024 * 1024)],
    ["8 MB of 'a < '", "a < ".repeat(2 * 1024 * 1024)],
  ])("%s adds only a handful of pieces", (_name, input) => {
    const original = Array.prototype.push;
    let pushes = 0;
    Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
      pushes++;
      return original.apply(this, items);
    };
    try {
      htmlToText(input);
    } finally {
      Array.prototype.push = original;
    }
    expect(pushes).toBeLessThan(100);
  });

  it("still keeps every bare '<' and its text", () => {
    expect(htmlToText("<p>a < b << c <</p>")).toBe("a < b << c <");
  });
});

describe("cleanText", () => {
  it("removes control characters and lone surrogates Postgres can't store faithfully", () => {
    expect(cleanText("a\u0000b\u0007c\u009Bd\uD800e\tf\ng")).toBe("abcde\tf\ng");
  });
});

describe("cleanDecodedLine (for text that is already decoded)", () => {
  it("does not decode entities again", () => {
    expect(cleanDecodedLine("  AT&amp;T\n ")).toBe("AT&amp;T");
  });

  it("otherwise works like cleanLine", () => {
    expect(cleanDecodedLine("   ")).toBeNull();
    expect([...(cleanDecodedLine("é".repeat(400)) ?? "")].length).toBe(300);
  });
});

describe("cleanLine", () => {
  it("makes one trimmed line", () => {
    expect(cleanLine("  Senior\n  Engineer\t ")).toBe("Senior Engineer");
  });

  it("returns null for nothing, blank or missing", () => {
    expect(cleanLine("   ")).toBeNull();
    expect(cleanLine(null)).toBeNull();
    expect(cleanLine(undefined)).toBeNull();
  });

  it("cuts a very long value at 300 characters with an ellipsis", () => {
    const line = cleanLine("é".repeat(400));
    expect(line && [...line].length).toBe(300);
    expect(line?.endsWith("…")).toBe(true);
  });
});

describe("truncateChars", () => {
  it("leaves text at or under the limit unchanged", () => {
    expect(truncateChars("abc", 3)).toBe("abc");
    expect(truncateChars("😀😀😀", 3)).toBe("😀😀😀");
  });

  it("cuts by characters, never splitting an emoji, and ends in …", () => {
    expect(truncateChars("abcdef", 4)).toBe("abc…");
    expect(truncateChars("😀😀😀😀", 3)).toBe("😀😀…");
    expect(truncateChars("a\ud83db\ud83dc", 3)).toBe("a\ud83d…"); // lone surrogates count as one, like spreading
  });

  // Copilot (PR #5): it spread the whole value into an array first; a fetched 8 MB field built
  // millions of entries to keep 300. Make string iteration throw during the call.
  it("cuts 8 MB without iterating the whole string", () => {
    const original = Object.getOwnPropertyDescriptor(String.prototype, Symbol.iterator)!;
    Object.defineProperty(String.prototype, Symbol.iterator, {
      ...original,
      value: () => {
        throw new Error("iterated");
      },
    });
    let cut: string;
    try {
      cut = truncateChars("😀".repeat(4 * 1024 * 1024), 300);
    } finally {
      Object.defineProperty(String.prototype, Symbol.iterator, original);
    }
    expect(cut).toBe(`${"😀".repeat(299)}…`);
  });
});
