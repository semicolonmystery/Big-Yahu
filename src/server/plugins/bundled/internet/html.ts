/**
 * HTML down to something worth reading, with no parser.
 *
 * This is a reducer, not a parser, and the difference matters in both
 * directions. It will mis-handle a `</script>` written inside a JavaScript
 * string, and it does not know that a `<div>` closes when its parent does.
 * Neither can hurt anything: nothing here is executed, rendered or trusted, and
 * the worst outcome of a mistake is a stray line of text in material the model
 * is already told to treat as quoted and untrustworthy.
 *
 * What it buys is not having a dependency. This repo keeps its dependencies
 * deliberate, and a DOM implementation is a large amount of attacker-facing
 * parsing code to carry in the bot process for the sake of stripping tags.
 */

/**
 * Elements holding code or markup rather than prose. An unclosed one takes the
 * rest of the document with it, which is what a browser does with `<script>` and
 * is the only safe reading of a page that opens one and never closes it.
 */
const RAW_TEXT_ELEMENTS = [
  'script', 'style', 'noscript', 'template', 'svg', 'math', 'canvas', 'iframe',
  'textarea',
];

/**
 * Elements whose contents are chrome — navigation, banners, cookie notices. An
 * unclosed one loses only its tag: the page's actual text often follows it, so
 * swallowing the remainder would throw away the article to save the menu.
 */
const CHROME_ELEMENTS = [
  'audio', 'video', 'form', 'select', 'nav', 'header', 'footer', 'aside',
  'menu', 'dialog', 'object', 'embed',
];

/** Elements that end a line, so the text does not run together into one paragraph. */
const BLOCK_ELEMENTS = [
  'p', 'div', 'br', 'hr', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'tr', 'td', 'th',
  'table', 'section', 'article', 'main', 'blockquote', 'pre', 'figure',
  'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label', 'details',
  'summary', 'address', 'fieldset', 'legend',
];

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  thinsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', deg: '°', plusmn: '±',
  times: '×', divide: '÷', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', dagger: '†',
  permil: '‰', prime: '′', Prime: '″', larr: '←', rarr: '→', harr: '↔', ne: '≠',
  le: '≤', ge: '≥', minus: '−', frac12: '½', frac14: '¼', frac34: '¾', shy: '',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]{1,31});/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      // Surrogate halves are not characters; String.fromCodePoint happily makes
      // a lone one, which then breaks every downstream JSON encoder.
      if (code >= 0xd800 && code <= 0xdfff) return '';
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** Enough to tell a page apart from a plain-text or JSON response. */
export function looksLikeHtml(text: string, contentType = ''): boolean {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return true;
  if (mime && mime !== 'text/plain') return false;
  return /<(?:!doctype\s+html|html|head|body|div|p|a\s|span|script)\b/i.test(text.slice(0, 4_000));
}

export interface ReducedPage {
  title: string | null;
  text: string;
}

/**
 * Link *text* survives on purpose: "see the changelog" with the anchor stripped
 * reads as a sentence, whereas dropping anchors wholesale removes most of what a
 * documentation page actually says. Link targets do not survive — a page full of
 * hrefs is a page full of URLs the model might then be tempted to fetch because
 * the page suggested it, which is the whole thing this plugin refuses to do.
 */
export function reduceHtml(html: string): ReducedPage {
  let working = html;

  // Comments first: a commented-out `<style>` would otherwise take the rest of
  // the document with it when the opening tag is matched to a later closer.
  working = working.replace(/<!--[\s\S]*?-->/g, ' ');
  working = working.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ');

  // Taken before any stripping, because an unclosed `<script>` in the head takes
  // the rest of the document with it below and the title would go with it.
  const titleMatch = /<title[^>]*>([\s\S]{0,400}?)<\/title\s*>/i.exec(working);

  for (const element of [...RAW_TEXT_ELEMENTS, ...CHROME_ELEMENTS]) {
    working = working.replace(
      new RegExp(`<${element}\\b[^>]*>[\\s\\S]*?<\\/${element}\\s*>`, 'gi'),
      ' ',
    );
  }
  // Whatever is left is unclosed, or self-closed, or a stray closing tag. The
  // lookbehind keeps a self-closed `<svg/>` from swallowing the article under it.
  for (const element of RAW_TEXT_ELEMENTS) {
    working = working.replace(new RegExp(`<${element}\\b[^>]*(?<!/)>[\\s\\S]*$`, 'i'), ' ');
  }
  for (const element of CHROME_ELEMENTS) {
    working = working.replace(new RegExp(`<\\/?${element}\\b[^>]*>`, 'gi'), ' ');
  }

  working = working.replace(new RegExp(`<\\/?(?:${BLOCK_ELEMENTS.join('|')})\\b[^>]*>`, 'gi'), '\n');
  working = working.replace(/<[^>]*>/g, '');
  working = decodeEntities(working);

  const text = working
    // Every flavour of newline becomes the one flavour before anything counts them.
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const title = titleMatch
    ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() || null
    : null;

  return { title, text };
}

/** A non-HTML body still gets its whitespace tidied, so limits mean the same thing either way. */
export function reducePlainText(text: string): ReducedPage {
  return {
    title: null,
    text: text
      .replace(/\r\n?/g, '\n')
      .replace(/[^\S\n]+/g, ' ')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  };
}
