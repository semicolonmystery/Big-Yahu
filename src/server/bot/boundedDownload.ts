/** Read a response incrementally; never allocate an unbounded attachment body. */
export async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new Error('file exceeds the byte limit');
  }
  if (!response.body) throw new Error('empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('file exceeds the byte limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/**
 * The rules both download paths share. They were written out twice, in two
 * files, and had already drifted: the image path omitted the port check, so a
 * pinned hostname on an unexpected port was still fetched. Two checks that must
 * agree eventually disagree, so there is one of them.
 */
function isSafeDiscordUrl(url: URL): boolean {
  return url.protocol === 'https:'
    && !url.username
    && !url.password
    && (!url.port || url.port === '443');
}

/** Attachments proper: the CDN, under an /attachments/ path. */
export function isDiscordAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return isSafeDiscordUrl(url)
      && ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
      && /^\/(?:ephemeral-)?attachments\/\d+\/\d+\//.test(url.pathname);
  } catch { return false; }
}

/**
 * Images additionally arrive through Discord's embed proxy, which serves other
 * hosts and paths, so this cannot simply reuse the attachment rule above.
 * Parsing here also means a malformed URL is a `false` rather than a throw at
 * the call site.
 */
export function isDiscordImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return isSafeDiscordUrl(url)
      && /^(?:cdn\.discordapp\.com|media\.discordapp\.net|images-ext-\d+\.discordapp\.net)$/.test(url.hostname);
  } catch { return false; }
}
