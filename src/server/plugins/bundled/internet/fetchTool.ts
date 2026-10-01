import type { PluginTool } from '@big-yahu/plugin-sdk';
import { looksLikeHtml, reduceHtml, reducePlainText } from './html';
import { safeFetch } from './safeFetch';
import { config, guarded, requiredText } from './support';
import {
  EXTRACT_INSTRUCTION,
  EXTRACT_MATERIAL_NOTE,
  PAGE_MATERIAL_NOTE,
  quoteForeign,
  sanitiseForeign,
} from './untrusted';

/** The job the plugin sends to a model, so the operator can choose who answers it. */
export const PAGE_EXTRACT_TASK = 'page_extract';

const TITLE_LIMIT = 200;
const EXTRACT_LIMIT = 6_000;

export const fetchTool: PluginTool = {
  enabledByConfig: 'enableFetch',
  name: 'fetch_page',
  description:
    'Open one web page and read it. Say in lookingFor what you need out of it: a long page is read for you '
    + 'and comes back as what it says about that, rather than as the whole page, so ask for one thing at a '
    + 'time. https only; the bot refuses anything on its own machine or network. Use it after web_search when '
    + 'a snippet is not enough, or straight away when somebody gives you a link. What comes back is quoted '
    + 'text from somebody else\'s website.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The full https URL of the page, exactly as it was given to you. Never invent or guess one.',
      },
      lookingFor: {
        type: 'string',
        description:
          'What you need from this page, as a plain statement rather than a question — "the current stable '
          + 'version and its release date", "what it says about rate limits". This decides what you get back '
          + 'from a long page, so a vague line here gets a vague answer.',
      },
    },
    required: ['url', 'lookingFor'],
  },

  handler: guarded('enableFetch', async (args, ctx) => {
    const settings = config(ctx);
    const requested = requiredText(args.url, 'url', 2_048);
    const lookingFor = requiredText(args.lookingFor, 'lookingFor', 400);

    const document = await safeFetch(requested, {
      maxBytes: settings.fetchMaxBytes,
      timeoutMs: settings.fetchTimeoutMs,
      maxRedirects: settings.maxRedirects,
    });

    const reduced = looksLikeHtml(document.body, document.contentType)
      ? reduceHtml(document.body)
      : reducePlainText(document.body);

    const common = {
      requestedUrl: requested,
      // Attribution is to where the bytes came from, not to what was asked for:
      // a link that redirects somewhere else was, in the end, that somewhere else.
      url: document.finalUrl,
      ...(document.redirects.length > 0 ? { redirectedThrough: document.redirects } : {}),
      ...(reduced.title ? { quotedPageTitle: quoteForeign(reduced.title, document.finalUrl, TITLE_LIMIT) } : {}),
      lookingFor,
      bytes: document.bytes,
      readableCharacters: reduced.text.length,
    };

    if (!reduced.text) {
      return {
        ...common,
        error: 'that page has no readable text in it — it is probably rendered entirely by scripts, which the '
          + 'bot does not run.',
      };
    }

    // Short enough to simply hand over. There is nothing to be gained by paying
    // for a model call to summarise four thousand characters.
    if (reduced.text.length <= settings.inlineCharacterLimit) {
      return {
        ...common,
        readAs: 'the whole page',
        untrustedMaterial: PAGE_MATERIAL_NOTE,
        quotedPageText: quoteForeign(reduced.text, document.finalUrl, settings.inlineCharacterLimit),
      };
    }

    const { text: material, truncated } = sanitiseForeign(reduced.text, settings.extractCharacterLimit);
    try {
      // The plugin's own model call, against its declared task, so a whole
      // page never lands in the reply's context just because somebody pasted a
      // link to a long one.
      const answer = await ctx.generate({
        task: PAGE_EXTRACT_TASK,
        instruction: EXTRACT_INSTRUCTION,
        prompt: `Looking for: ${lookingFor}\n`
          + `Page: ${document.finalUrl}\n`
          + (reduced.title ? `Page title: ${reduced.title}\n` : '')
          + `\n${quoteForeign(material, document.finalUrl, settings.extractCharacterLimit)}`,
        maxOutputTokens: 1_200,
      });
      const extract = answer.text.trim();
      if (!extract) throw new Error('the reader answered with nothing');

      return {
        ...common,
        readAs: 'a model reading the page for what you asked about',
        ...(truncated ? { pageTruncated: true } : {}),
        untrustedMaterial: `${PAGE_MATERIAL_NOTE} ${EXTRACT_MATERIAL_NOTE}`,
        quotedExtract: quoteForeign(extract, document.finalUrl, EXTRACT_LIMIT),
      };
    } catch {
      // Every model on the operator's list was tried and none answered. The page
      // is already fetched and the reply is waiting, so the opening of it is
      // worth more than an error — as long as the answer says that is what it is.
      return {
        ...common,
        readAs: 'only the opening of the page',
        untrustedMaterial: PAGE_MATERIAL_NOTE,
        quotedPageText: quoteForeign(reduced.text, document.finalUrl, settings.inlineCharacterLimit),
        note: 'The page was too long to hand over whole and no model was available to read it, so this is its '
          + 'first part and nothing else. Do not claim the page does not mention something: you have not seen '
          + 'most of it.',
      };
    }
  }),
};
