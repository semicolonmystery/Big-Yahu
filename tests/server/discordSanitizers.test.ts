import { describe, expect, it } from 'vitest';
import {
  buildJumpLink, mentionedUserIds, mentionifyNames, mentionsIn, normaliseFactMentions, readMention,
  restoreMentions, stripPromptMarkers, stripUnknownJumpLinks, stripUnknownMentions,
} from '../../src/shared/discord';

describe('Discord output sanitizers', () => {
  it('keeps only jump links for messages actually shown', () => {
    const known = buildJumpLink('100', '200', '300');
    const unknown = buildJumpLink('100', '200', '400');
    expect(stripUnknownJumpLinks(`See ${known} or ${unknown}`, new Set(['300']))).toBe(`See ${known} or `);
  });

  it('checks user and channel mention namespaces independently', () => {
    expect(stripUnknownMentions('<@123> <@!456> <#123> <#456>', (id) => id === '456', (id) => id === '123'))
      .toBe('<@123> <#456>');
  });

  it('strips prompt markers while retaining ordinary brackets and message text', () => {
    const text = 'answer [id=123] [replying to id=456 by <@789>] [factId=f-1] [2 images not shown]\n[score 4.5] [memory=2] [keep this]';
    expect(stripPromptMarkers(text)).toBe('answer\n [keep this]');
  });

  it('collects deduplicated mentions and reads their namespace', () => {
    expect(mentionedUserIds('<@123> <#456> <@!123> <@789>')).toEqual(['123', '789']);
    expect(mentionsIn('<@123> <#456> <@123>')).toEqual(['<@123>', '<#456>']);
    expect(readMention('<#456>')).toEqual({ id: '456', isChannel: true });
    expect(readMention('<@!123>')).toEqual({ id: '123', isChannel: false });
  });
});

describe('nickname normalization', () => {
  const roster = new Map([['Bob', '123'], ['Bobby', '456'], ['Žaneta', '789'], ['user.name', '999']]);

  it('replaces longest names first and keeps names inside larger words untouched', () => {
    expect(mentionifyNames('Bobby met Bob and Žaneta at Bobcat with user.name.', roster))
      .toBe('<@456> met <@123> and <@789> at Bobcat with <@999>.');
  });

  it('does not rewrite quoted nicknames, short words or numeric names', () => {
    const names = new Map([...roster, ['Al', '111'], ['123', '222']]);
    expect(mentionifyNames('Bob uses "Bobby", “Žaneta” and `Bob`; Al has 123 points.', names))
      .toBe('<@123> uses "Bobby", “Žaneta” and `Bob`; Al has 123 points.');
  });

  it('supports display names with their own quotes and collapses aliases for the same person', () => {
    const names = new Map([['First "Nickname" Last', '123'], ['Nickname', '123'], ['username', '123']]);
    expect(normaliseFactMentions('First "Nickname" Last aka username won.', names)).toBe('<@123> won.');
  });

  it('normalizes explicit and transcript-annotated mentions', () => {
    expect(normaliseFactMentions('@Bobby met <@123>(Bob).', roster)).toBe('<@456> met <@123>.');
  });

  it('does not turn a longer unknown username or email address into a known ping', () => {
    expect(restoreMentions('@Bobcat emailed user@Bob.com; @Bob answered.', roster))
      .toBe('@Bobcat emailed user@Bob.com; <@123> answered.');
  });

  it('preserves an explicit @nickname quoted as the subject of a fact', () => {
    expect(normaliseFactMentions('Bob uses the nickname "@Bobby".', roster))
      .toBe('<@123> uses the nickname "@Bobby".');
  });

  it('supports punctuation in handles without matching longer dotted usernames', () => {
    expect(restoreMentions('@user.name met @Bob. @user.name2 and @Bob.example stayed home.', roster))
      .toBe('<@999> met <@123>. @user.name2 and @Bob.example stayed home.');
  });
});
