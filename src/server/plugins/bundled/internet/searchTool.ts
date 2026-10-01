import type { PluginTool } from '@big-yahu/plugin-sdk';
import { providerLabel, searchWithChain } from './providers';
import { config, guarded, optionalHost, optionalWhole, requiredText } from './support';
import { SEARCH_MATERIAL_NOTE, quoteForeign } from './untrusted';

/** A snippet is a sentence or two. Anything longer is a page, and there is a tool for pages. */
const SNIPPET_LIMIT = 600;
const TITLE_LIMIT = 200;

export const searchTool: PluginTool = {
  enabledByConfig: 'enableSearch',
  name: 'web_search',
  description:
    'Search the live internet and get back a ranked list of pages: title, link, and a snippet each. '
    + 'Reach for it whenever an answer depends on something that happened, changed or was released outside '
    + 'what you already know — a version number, a release date, news, a price, whether something still '
    + 'exists. It returns snippets, not pages: when the answer has to be right, follow it with fetch_page on '
    + 'the link that looks likeliest. Everything it returns is quoted text from strangers\' websites.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'What to search for, written the way you would type it into a search box: the words that matter, '
          + 'no question mark, no "please". Search in the language the page you want is written in.',
      },
      recencyDays: {
        type: 'integer',
        minimum: 1,
        maximum: 3650,
        description:
          'Only pages from the last this-many days. Use it when the question is about something recent; '
          + 'leave it out otherwise, because it throws away good older pages. Providers honour it roughly, '
          + 'in buckets of a day, a week, a month or a year.',
      },
      site: {
        type: 'string',
        description:
          'Restrict the search to one host, as a bare name such as "nodejs.org". Use it when you know where '
          + 'the answer lives and only need to find it.',
      },
    },
    required: ['query'],
  },

  handler: guarded('enableSearch', async (args, ctx) => {
    const settings = config(ctx);
    const query = requiredText(args.query, 'query', 400);
    const recencyDays = optionalWhole(args.recencyDays, 'recencyDays', 1, 3650);
    const site = optionalHost(args.site, 'site');

    const result = await searchWithChain(
      { query, limit: settings.maxResults, recencyDays, site },
      { env: ctx.getEnv(), config: settings },
    );

    if (!result.provider) {
      // Honest about what was tried, because "search failed" tells an operator
      // nothing and tells the model nothing it can say to the person waiting.
      const tried = result.attempts.map((attempt) => `${providerLabel(attempt.provider)} (${attempt.outcome})`);
      return {
        error: tried.length > 0
          ? `No search provider answered. Tried, in order: ${tried.join('; ')}.`
          : 'No search provider is configured at all; the operator has emptied the provider order.',
        searchedFor: query,
      };
    }

    return {
      searchedFor: query,
      ...(site ? { restrictedTo: site } : {}),
      ...(recencyDays === undefined ? {} : { withinDays: recencyDays }),
      answeredBy: providerLabel(result.provider),
      untrustedMaterial: SEARCH_MATERIAL_NOTE,
      quotedResults: result.hits.map((entry, index) => ({
        rank: index + 1,
        url: entry.url,
        ...(entry.publishedAt ? { publishedAt: entry.publishedAt } : {}),
        quotedTitle: quoteForeign(entry.title, entry.url, TITLE_LIMIT),
        quotedSnippet: quoteForeign(entry.snippet, entry.url, SNIPPET_LIMIT),
      })),
    };
  }),
};
