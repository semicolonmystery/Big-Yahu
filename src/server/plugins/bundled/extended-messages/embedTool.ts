import type { APIEmbed } from 'discord.js';
import type { PluginTool } from '@big-yahu/plugin-sdk';
import {
  ALLOWED_MENTIONS,
  actionSlot,
  booleanValue,
  guarded,
  httpsUrl,
  invocationChannel,
  optionalText,
  requireBotPermissions,
  requiredText,
} from './support';

/**
 * Discord's own limits, every one of them enforced rather than trimmed to.
 *
 * An embed cut to fit is worse than no embed: a description that stops mid-word
 * or a table missing its last three rows is something the bot cannot see it did,
 * so it tells people the thing is there and it is not. A refusal with a reason it
 * can read means it writes a shorter one.
 */
const LIMITS = {
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  authorName: 256,
  /** Everything above, added together, as Discord counts it. */
  total: 6000,
} as const;

/** `#5865F2`, `5865F2`, or `0x5865F2`. Discord wants the integer. */
function colour(value: unknown): number | undefined {
  const text = optionalText(value, 'color', 16);
  if (text === undefined) return undefined;
  const hex = text.replace(/^#/, '').replace(/^0x/i, '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error('color must be a hex colour such as #5865F2.');
  return Number.parseInt(hex, 16);
}

/** An ISO 8601 instant, or `now`. */
function timestamp(value: unknown): string | undefined {
  const text = optionalText(value, 'timestamp', 40);
  if (text === undefined) return undefined;
  if (text.toLowerCase() === 'now') return new Date().toISOString();
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('timestamp must be an ISO 8601 date and time, or "now".');
  }
  return parsed.toISOString();
}

function object(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

/** What Discord adds up against the 6000 limit: the text, not the urls. */
function totalLength(embed: APIEmbed): number {
  const parts = [
    embed.title ?? '',
    embed.description ?? '',
    embed.footer?.text ?? '',
    embed.author?.name ?? '',
    ...(embed.fields ?? []).flatMap((field) => [field.name, field.value]),
  ];
  return parts.reduce((sum, part) => sum + [...part].length, 0);
}

export const embedTool: PluginTool = {
  enabledByConfig: 'enableEmbeds',
  // The embed is in the channel once this returns. Nothing to read back.
  effect: true,
  name: 'send_embed',
  description:
    'Post a Discord embed in this channel: a boxed, laid-out block with a title, a description, and labelled '
    + 'fields. For something structured that is genuinely worth laying out — a comparison, a set of rules, a '
    + 'summary with several parts, a result table. Never for ordinary chat: an embed around two sentences looks '
    + 'like a press release and is the wrong answer to a question. Write your reply as well; the embed goes out beside it.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: `Heading at the top, at most ${LIMITS.title} characters.` },
      description: {
        type: 'string',
        description:
          `The body, at most ${LIMITS.description} characters. Discord markdown works: **bold**, *italic*, `
          + '`code`, links, and - bullet lines.',
      },
      url: { type: 'string', description: 'https URL the title links to.' },
      color: { type: 'string', description: 'Stripe down the left edge, as a hex colour such as #5865F2.' },
      author: {
        type: 'object',
        description: 'Small line above the title.',
        properties: {
          name: { type: 'string', description: `Who or what this is from, at most ${LIMITS.authorName} characters.` },
          url: { type: 'string', description: 'https URL the author name links to.' },
          iconUrl: { type: 'string', description: 'https URL of a small round image beside the author name.' },
        },
        required: ['name'],
      },
      thumbnail: { type: 'string', description: 'https URL of a small image in the top right corner.' },
      image: { type: 'string', description: 'https URL of a large image across the bottom.' },
      footer: {
        type: 'object',
        description: 'Small grey line along the bottom.',
        properties: {
          text: { type: 'string', description: `The footer line, at most ${LIMITS.footer} characters.` },
          iconUrl: { type: 'string', description: 'https URL of a small image beside the footer text.' },
        },
        required: ['text'],
      },
      timestamp: {
        type: 'string',
        description: 'An ISO 8601 date and time shown in the footer, or "now" for right now. Leave it out unless the time matters.',
      },
      fields: {
        type: 'array',
        maxItems: LIMITS.fields,
        description:
          `Labelled rows under the description, at most ${LIMITS.fields}. Each is a short name and its value. `
          + 'Three inline fields sit side by side on one line, which is how a small table is made.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: `The label, at most ${LIMITS.fieldName} characters.` },
            value: { type: 'string', description: `Its content, at most ${LIMITS.fieldValue} characters. Markdown works here too.` },
            inline: {
              type: 'boolean',
              description: 'True puts it beside the previous inline fields, up to three across. Defaults to false, one per line.',
            },
          },
          required: ['name', 'value'],
        },
      },
    },
    required: [],
  },
  handler: guarded('enableEmbeds', async (args, ctx) => {
    const author = object(args.author, 'author');
    const footer = object(args.footer, 'footer');

    if (args.fields !== undefined && args.fields !== null && !Array.isArray(args.fields)) {
      throw new Error('fields must be a list.');
    }
    const rawFields = Array.isArray(args.fields) ? args.fields : [];
    if (rawFields.length > LIMITS.fields) {
      throw new Error(`Discord allows at most ${LIMITS.fields} fields; that one has ${rawFields.length}.`);
    }
    const fields = rawFields.map((entry, index) => {
      const field = object(entry, `fields[${index}]`) ?? {};
      return {
        name: requiredText(field.name, `fields[${index}].name`, LIMITS.fieldName),
        value: requiredText(field.value, `fields[${index}].value`, LIMITS.fieldValue),
        inline: booleanValue(field.inline, `fields[${index}].inline`, false),
      };
    });

    const title = optionalText(args.title, 'title', LIMITS.title);
    const description = optionalText(args.description, 'description', LIMITS.description);
    const url = httpsUrl(args.url, 'url');
    const color = colour(args.color);
    const thumbnail = httpsUrl(args.thumbnail, 'thumbnail');
    const image = httpsUrl(args.image, 'image');
    const at = timestamp(args.timestamp);

    const embed: APIEmbed = {
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(url ? { url } : {}),
      ...(color === undefined ? {} : { color }),
      ...(author
        ? {
          author: {
            name: requiredText(author.name, 'author.name', LIMITS.authorName),
            ...(httpsUrl(author.url, 'author.url') ? { url: httpsUrl(author.url, 'author.url') } : {}),
            ...(httpsUrl(author.iconUrl, 'author.iconUrl')
              ? { icon_url: httpsUrl(author.iconUrl, 'author.iconUrl') }
              : {}),
          },
        }
        : {}),
      ...(thumbnail ? { thumbnail: { url: thumbnail } } : {}),
      ...(image ? { image: { url: image } } : {}),
      ...(footer
        ? {
          footer: {
            text: requiredText(footer.text, 'footer.text', LIMITS.footer),
            ...(httpsUrl(footer.iconUrl, 'footer.iconUrl')
              ? { icon_url: httpsUrl(footer.iconUrl, 'footer.iconUrl') }
              : {}),
          },
        }
        : {}),
      ...(at ? { timestamp: at } : {}),
      ...(fields.length > 0 ? { fields } : {}),
    };

    // An embed of nothing but a colour renders as an empty box, which reads as a
    // bug rather than a message.
    if (embed.title === undefined && embed.description === undefined && (embed.fields ?? []).length === 0) {
      throw new Error('An embed needs at least a title, a description or one field.');
    }

    const total = totalLength(embed);
    if (total > LIMITS.total) {
      throw new Error(
        `Discord allows ${LIMITS.total} characters across an embed's title, description, fields, author and footer; `
        + `that one is ${total}. Write a shorter one rather than expecting it to be cut.`,
      );
    }

    const channel = invocationChannel(ctx);
    requireBotPermissions(ctx, channel, [
      { name: 'SendMessages', label: 'Send Messages' },
      // Without Embed Links Discord accepts the message and drops the embed, so
      // the bot would report having posted something nobody can see.
      { name: 'EmbedLinks', label: 'Embed Links' },
    ]);

    const slot = actionSlot(ctx);
    if (slot) return slot;

    const sent = await channel.send({ embeds: [embed], allowedMentions: ALLOWED_MENTIONS });
    return { ok: true, messageId: sent.id, characters: total, fields: fields.length };
  }),
};
