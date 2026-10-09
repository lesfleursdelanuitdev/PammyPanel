// Cloudflare's published ranges, as deploy/cloudflare-ips.txt has them (test/hosts-checks.test.ts
// checks the two agree): a name behind Cloudflare's proxy resolves to these, and on a domain
// with Cloudflare in front nginx trusts CF-Connecting-IP from these only (realIpConf below).
// To refresh both from Cloudflare: node tools/refresh-cloudflare-ips.ts, then a release.
export const CLOUDFLARE_RANGES: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

// A range as nginx takes it in set_real_ip_from: an address and a prefix length, nothing else.
const RANGE_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}|[0-9a-f:]+:[0-9a-f:]*\/\d{1,3})$/;

// What a server block on a domain with Cloudflare in front includes
// (docs/security-performance-review.md S6): CF-Connecting-IP is believed only when the
// connection itself comes from one of Cloudflare's ranges, so $remote_addr -- the logs,
// limit_req and the X-Real-IP every location hands on -- is the visitor, and someone going
// straight to this server can't name another address. Any nginx front of the panel's
// (the hosts, later lfdln-backend's) includes this same file.
export function realIpConf(ranges: readonly string[] = CLOUDFLARE_RANGES): string {
  if (ranges.length < 10) throw new Error('hosts: suspiciously few Cloudflare ranges');
  for (const r of ranges) {
    if (!RANGE_RE.test(r)) throw new Error(`hosts: "${String(r).slice(0, 60)}" is not an address range`);
    // never "everyone": a /0-/7 here would let anyone name any address
    if (Number(r.split('/')[1]) < 8) throw new Error(`hosts: ${r} is far too wide to trust`);
  }
  return '# Written by the panel\'s routing helper from @panel/hosts/cloudflare (S6). Changes here are overwritten.\n'
    + ranges.map((r) => `set_real_ip_from ${r};\n`).join('') + 'real_ip_header CF-Connecting-IP;\n';
}
