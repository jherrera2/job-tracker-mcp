// Turns the HTML that job APIs send into plain text, and cleans text fields before they are saved.
//
// Job postings are untrusted text (PRD 01 §6). Nothing here runs or renders the HTML: tags are
// removed by a small linear scanner and entities are decoded LAST, so text like "&lt;script&gt;" ends
// up as the harmless characters "<script>" in plain text, never as a tag. The fit check (step 6)
// wraps the description as data, so instructions inside it stay data too.
import { decodeHTMLStrict } from "entities";
import { nextCharIndex } from "../domain/master-resume.js";

/**
 * Decodes HTML character references (&amp;, &Eacute;, &#39;, &#x2014;...) ONCE, with the full HTML
 * entity table, case-sensitively and only when the ";" is there (so "?a=1&para=2" in a link stays
 * as it is). Unknown names stay as written; an invalid number becomes U+FFFD, as in a browser.
 * Uses the `entities` package (the decoder behind parse5 and htmlparser2) rather than a
 * hand-kept table, which was incomplete and folded case (&Eacute; came out as é).
 */
export function decodeEntities(text: string): string {
  return decodeHTMLStrict(text);
}

// Tags that start or end a block of text, so they become a paragraph break.
const BLOCK_TAGS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "tr",
  "section", "article", "header", "footer", "blockquote", "pre",
]);

// What may follow "<" for it to be markup: a letter, "/", "!" or "?". Anything else ("a < b") is text.
const TAG_START = /[A-Za-z/!?]/;
const TAG_NAME = /^(\/?)([A-Za-z][A-Za-z0-9]*)/;

/**
 * HTML → plain text: paragraphs and headings become lines, list items become "- " lines.
 *
 * A hand-written scanner, not regular expressions over the whole text, so it runs in LINEAR time
 * on any input: patterns like /<[a-z][^>]*>/g rescan to the end of the text from every "<" that
 * never closes, which is quadratic, and the fetch timeout can't interrupt synchronous code
 * (Copilot finding on PR #4). Every search below starts where the previous one stopped, and a
 * search that finds nothing ends the scan, so no character is read more than a few times.
 */
export function htmlToText(html: string): string {
  // Text between tags (bare "<" included) is NOT pushed piece by piece: `textStart` marks where the
  // current run of literal text began, and the run is pushed as ONE slice when markup interrupts
  // it, so a body full of "<" can't grow the array to millions of entries (Copilot, PR #4).
  const parts: string[] = [];
  let textStart = 0;
  let i = 0;
  /** Ends the current text run at `end`, adds `replacement`, and starts a new run at `next`. */
  const markup = (end: number, replacement: string, next: number) => {
    parts.push(html.slice(textStart, end));
    if (replacement !== "") parts.push(replacement);
    textStart = next;
  };

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) {
        markup(lt, "", html.length); // an unclosed comment hides the rest, as in a browser
        break;
      }
      i = end + 3;
      markup(lt, "", i);
      continue;
    }
    if (!TAG_START.test(html.charAt(lt + 1))) {
      i = lt + 1; // a bare "<" in text: it stays part of the current text run
      continue;
    }
    const gt = findTagEnd(html, lt + 1);
    if (gt === -1) break; // no ">" anywhere after this: it is text, not a tag (kept in the run)
    i = gt + 1;
    const name = TAG_NAME.exec(html.slice(lt + 1, Math.min(gt, lt + 33)));
    if (!name?.[2]) {
      markup(lt, "", i); // <!doctype>, <?xml?>, </ > ...: dropped
      continue;
    }
    const closing = name[1] === "/";
    const tag = name[2].toLowerCase();

    if (!closing && (tag === "script" || tag === "style")) {
      // Skip to the matching end tag (any case); an unclosed one hides the rest, as in a browser.
      const endTag = tag === "script" ? /<\/script\s*>/gi : /<\/style\s*>/gi;
      endTag.lastIndex = i;
      if (!endTag.exec(html)) {
        markup(lt, "", html.length);
        break;
      }
      i = endTag.lastIndex;
      markup(lt, "", i);
    } else if (tag === "br") {
      markup(lt, "\n", i);
    } else if (tag === "li") {
      markup(lt, closing ? "" : "\n- ", i); // the next <li> (or the list's end) starts a new line
    } else {
      markup(lt, BLOCK_TAGS.has(tag) ? "\n\n" : "", i);
    }
  }
  parts.push(html.slice(textStart));
  // Entities are decoded LAST, so "&lt;script&gt;" becomes the text "<script>", never a tag.
  return normalizeText(decodeEntities(parts.join("")));
}

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/**
 * Where the tag starting at `from` ends: the first ">" that is not inside a quoted attribute value
 * (`<a title="x > y">` ends after the second quote), or -1 if there is no ">" at all. A quote only
 * counts right after "=" (as in HTML), so an apostrophe elsewhere ("don't") is just a character.
 *
 * A quote that never closes is treated as a typo: the tag ends at its first ">" (the rule before
 * quotes were understood), so the rest of the posting is still read as HTML and later scripts,
 * styles and comments stay hidden.
 *
 * Linear: every step moves forward. A failed search for a closing quote proves there is no such
 * quote character anywhere later, so no later tag can start that search again: at most one failed
 * search per quote kind in the whole document, with no bookkeeping needed.
 */
function findTagEnd(html: string, from: number): number {
  let k = from;
  while (k < html.length) {
    const c = html.charAt(k);
    if (c === ">") return k;
    k++;
    if (c !== "=") continue;
    while (k < html.length && isSpace(html.charAt(k))) k++;
    const quote = html.charAt(k);
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, k + 1);
      // No ">" was seen between `from` and here, so the first ">" after the "<" is after k.
      if (close === -1) return html.indexOf(">", k);
      k = close + 1;
    }
  }
  return -1;
}

/**
 * Tidies plain text: control characters removed, blank space inside each line collapsed, lines
 * trimmed, at most one blank line in a row, no blank lines at the ends.
 */
export function normalizeText(text: string): string {
  const lines = cleanText(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim());
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * Removes what can't be stored or shown faithfully: control characters (except tab and line feed;
 * carriage returns go too) and lone UTF-16 surrogates. Text from a job site isn't the user's fault,
 * so it is cleaned rather than rejected.
 */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(CONTROL_CHARACTERS, "").replace(/[\uD800-\uDFFF]/gu, "");
}

export const MAX_LINE_CHARS = 300;

/**
 * A short field (title, company, location, pay) straight from an API: entities decoded once, then
 * one trimmed line, ≤ 300 characters, or null.
 */
export function cleanLine(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : cleanDecodedLine(decodeEntities(value));
}

/**
 * Like cleanLine, for text that is ALREADY decoded (from htmlToText, or values built from cleaned
 * parts). It does not decode again, so a posting that really says "AT&amp;T" keeps saying it.
 */
export function cleanDecodedLine(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const line = cleanText(value).replace(/\s+/g, " ").trim();
  if (line === "") return null;
  return truncateChars(line, MAX_LINE_CHARS);
}

/** `text` cut to at most `max` characters (code points), ending in "…" when it was cut. */
export function truncateChars(text: string, max: number): string {
  // Walks at most `max` characters instead of spreading the whole value into an array: a fetched
  // field can be megabytes long and only the first few hundred characters are kept (Copilot, PR #5).
  if (text.length <= max) return text; // never more characters than UTF-16 units
  let end = 0; // after the loop: where the first max - 1 characters end
  for (let kept = 0; kept < max - 1 && end < text.length; kept++) end = nextCharIndex(text, end);
  // At most one character left after them: the text has at most `max` characters, keep it whole.
  if (end >= text.length || nextCharIndex(text, end) >= text.length) return text;
  return `${text.slice(0, end)}…`;
}
