import { deflateSync, inflateSync } from 'fflate';

/**
 * Share links keep the search in the URL fragment (never sent to a server). Compressed with deflate,
 * encoded as base64url. Decoding is bounded so a crafted link cannot exhaust memory.
 */
const MAX_DECODED = 200_000;
const MAX_ENCODED = 300_000;

export function encodeShare(spl: string): string {
  const bytes = deflateSync(new TextEncoder().encode(spl), { level: 9 });
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeShare(encoded: string): string | undefined {
  if (encoded.length > MAX_ENCODED || !/^[A-Za-z0-9_-]*$/.test(encoded)) return undefined;
  try {
    const bin = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const out = new Uint8Array(MAX_DECODED);
    const inflated = inflateSync(bytes, { out });
    // inflateSync returns a view of `out`; a stream longer than out is truncated → refuse it.
    if (inflated.length >= MAX_DECODED) return undefined;
    return new TextDecoder('utf-8', { fatal: true }).decode(inflated);
  } catch {
    return undefined;
  }
}

export function shareUrl(spl: string): string {
  const url = new URL(globalThis.location.href);
  url.hash = `q=${encodeShare(spl)}`;
  return url.toString();
}

export function readShareFromHash(hash: string): string | undefined {
  const m = /^#q=([A-Za-z0-9_-]+)$/.exec(hash);
  return m ? decodeShare(m[1] as string) : undefined;
}
