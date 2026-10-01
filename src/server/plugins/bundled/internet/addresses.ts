import { lookup } from 'node:dns/promises';

/**
 * Where the plugin decides whether a URL may be opened at all.
 *
 * `boundedDownload.ts` can get away with an allow-list of hostnames because
 * every URL it sees came from Discord's own CDN. Here the URL is whatever a
 * model wrote, or wherever a page it already fetched points next, so the
 * hostname is worth nothing on its own: `localhost` is a name, `127.0.0.1` is a
 * name, `metadata.internal` is a name, and a domain somebody controls can be
 * made to resolve to any of them. The only honest question is what address the
 * connection would actually go to, so that is what gets asked.
 *
 * This file answers it for one hostname. Re-asking it at every redirect hop is
 * `safeFetch`'s job.
 */

/** Rejected before DNS is even asked. Cheap, and never a substitute for the resolved check below. */
const REFUSED_SUFFIXES = ['localhost', '.localhost', '.local', '.internal', '.home.arpa', '.onion'];

/** Dotted quad to a 32-bit number, strictly: four parts, no leading zeros, nothing clever. */
export function parseIpv4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** Eight 16-bit groups, or null. `::` compression and a trailing dotted quad are both handled. */
export function parseIpv6(text: string): number[] | null {
  // A zone id only ever accompanies a link-local address, so its presence is
  // itself the answer. Refusing here keeps the parser from having to guess.
  if (text.includes('%')) return null;
  const split = text.indexOf('::');
  if (split !== -1 && text.indexOf('::', split + 1) !== -1) return null;

  const headText = split === -1 ? text : text.slice(0, split);
  const tailText = split === -1 ? '' : text.slice(split + 2);

  const read = (source: string, isFinalSegment: boolean): number[] | null => {
    if (!source) return [];
    const parts = source.split(':');
    const groups: number[] = [];
    for (const [index, part] of parts.entries()) {
      if (part.includes('.')) {
        // A dotted quad is legal only as the very last piece of the address.
        if (!isFinalSegment || index !== parts.length - 1) return null;
        const packed = parseIpv4(part);
        if (packed === null) return null;
        groups.push(Math.floor(packed / 0x10000), packed % 0x10000);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const head = read(headText, split === -1);
  const tail = read(tailText, true);
  if (!head || !tail) return null;

  if (split === -1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  // `::` stands for at least one group; a full eight written out with one is malformed.
  if (missing < 1) return null;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

function inBlock(address: number, prefix: string, bits: number): boolean {
  const base = parseIpv4(prefix);
  if (base === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((address >>> 0) & mask) === ((base >>> 0) & mask);
}

/** The reason an IPv4 address may not be reached, or null when it may. */
export function classifyIpv4(address: number): string | null {
  if (inBlock(address, '0.0.0.0', 8)) return 'an unspecified or this-network address';
  if (inBlock(address, '10.0.0.0', 8)) return 'a private address (10.0.0.0/8)';
  if (inBlock(address, '100.64.0.0', 10)) return 'a carrier-grade NAT address (100.64.0.0/10)';
  if (inBlock(address, '127.0.0.0', 8)) return 'a loopback address (127.0.0.0/8)';
  if (inBlock(address, '169.254.0.0', 16)) return 'a link-local address (169.254.0.0/16)';
  if (inBlock(address, '172.16.0.0', 12)) return 'a private address (172.16.0.0/12)';
  if (inBlock(address, '192.0.0.0', 24)) return 'an IETF protocol assignment (192.0.0.0/24)';
  if (inBlock(address, '192.0.2.0', 24)) return 'a documentation address (192.0.2.0/24)';
  if (inBlock(address, '192.168.0.0', 16)) return 'a private address (192.168.0.0/16)';
  if (inBlock(address, '198.18.0.0', 15)) return 'a benchmarking address (198.18.0.0/15)';
  if (inBlock(address, '198.51.100.0', 24)) return 'a documentation address (198.51.100.0/24)';
  if (inBlock(address, '203.0.113.0', 24)) return 'a documentation address (203.0.113.0/24)';
  if (inBlock(address, '224.0.0.0', 4)) return 'a multicast address (224.0.0.0/4)';
  if (inBlock(address, '240.0.0.0', 4)) return 'a reserved or broadcast address (240.0.0.0/4)';
  return null;
}

/** The reason an IPv6 address may not be reached, or null when it may. */
export function classifyIpv6(groups: number[]): string | null {
  const embeddedV4 = (high: number, low: number): number => high * 0x10000 + low;

  if (groups.every((group) => group === 0)) return 'the unspecified address (::)';
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return 'the loopback address (::1)';

  // An IPv4 address wearing an IPv6 hat is still that IPv4 address, and
  // `new URL()` writes it back in hex groups, so it has to be unwrapped rather
  // than pattern-matched.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const reason = classifyIpv4(embeddedV4(groups[6], groups[7]));
    return reason ? `${reason}, written as an IPv6 address` : null;
  }
  // The NAT64 well-known prefix addresses a translator, never a web server, and
  // where the embedded IPv4 sits depends on which length of the prefix is in
  // use. Refused whole rather than unwrapped from the wrong offset.
  if (groups[0] === 0x64 && groups[1] === 0xff9b) return 'a NAT64 translation address (64:ff9b::/32)';
  // 6to4 carries its IPv4 in the next two groups; Teredo hides the client's
  // behind an XOR and is refused outright rather than half-understood.
  if (groups[0] === 0x2002) {
    const reason = classifyIpv4(embeddedV4(groups[1], groups[2]));
    return reason ? `${reason}, tunnelled over 6to4` : null;
  }
  if (groups[0] === 0x2001 && groups[1] === 0x0000) return 'a Teredo tunnel address (2001::/32)';

  if (groups[0] === 0x0100 && groups.slice(1, 4).every((group) => group === 0)) {
    return 'a discard-only address (100::/64)';
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return 'a unique-local address (fc00::/7)';
  if ((groups[0] & 0xffc0) === 0xfe80) return 'a link-local address (fe80::/10)';
  if ((groups[0] & 0xffc0) === 0xfec0) return 'a site-local address (fec0::/10)';
  if ((groups[0] & 0xff00) === 0xff00) return 'a multicast address (ff00::/8)';
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return 'a documentation address (2001:db8::/32)';
  return null;
}

/** The reason one resolved address may not be reached, or null when it may. */
export function classifyAddress(address: string): string | null {
  const bare = address.replace(/^\[/, '').replace(/\]$/, '');
  const v4 = parseIpv4(bare);
  if (v4 !== null) return classifyIpv4(v4);
  const v6 = parseIpv6(bare);
  if (v6) return classifyIpv6(v6);
  return 'not an address this bot can check';
}

/** True when the hostname is itself a literal address rather than a name to resolve. */
export function isAddressLiteral(hostname: string): boolean {
  const bare = hostname.replace(/^\[/, '').replace(/\]$/, '');
  return parseIpv4(bare) !== null || parseIpv6(bare) !== null;
}

export type Resolver = (hostname: string) => Promise<Array<{ address: string }>>;

const resolveAll: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

/**
 * Throws unless every address this hostname resolves to is one the bot may
 * connect to. Refusing on *any* bad answer rather than all of them is
 * deliberate: a name answering with both a public address and 127.0.0.1 is not
 * a name with a stray record, it is somebody hoping one of the two gets used.
 *
 * What this cannot close: Node's `fetch` resolves the name again itself, so an
 * attacker controlling a zero-TTL record could in principle answer differently
 * for that second lookup. Closing it properly means connecting to the address
 * that was checked, which needs a custom undici dispatcher — a dependency this
 * repo does not have and will not grow for this. The window is narrow, the
 * check is re-run at every redirect hop, and the limitation is written down
 * here rather than left for somebody to discover.
 */
export async function assertReachableHost(hostname: string, resolver: Resolver = resolveAll): Promise<void> {
  const bare = hostname.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
  if (!bare) throw new Error('that URL has no host');

  const lowered = bare.toLowerCase();
  if (REFUSED_SUFFIXES.some((suffix) => lowered === suffix || lowered.endsWith(suffix))) {
    throw new Error(`refusing ${bare}: that name is local to the machine or network the bot runs on`);
  }

  if (isAddressLiteral(bare)) {
    const reason = classifyAddress(bare);
    if (reason) throw new Error(`refusing ${bare}: that is ${reason}`);
    return;
  }

  let answers: Array<{ address: string }>;
  try {
    answers = await resolver(bare);
  } catch {
    throw new Error(`refusing ${bare}: that host name does not resolve`);
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new Error(`refusing ${bare}: that host name does not resolve`);
  }
  for (const answer of answers) {
    const reason = classifyAddress(String(answer?.address ?? ''));
    if (reason) throw new Error(`refusing ${bare}: it resolves to ${reason}`);
  }
}
