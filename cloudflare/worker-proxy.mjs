// Preserve the public request URL/path/query/body while addressing the private
// container listener. This shape follows Cloudflare's Container WebSocket proxy
// pattern; the returned port Response must be returned untouched for upgrades.
export function rewriteForContainer(request) {
  const url = new URL(request.url);
  url.protocol = 'http:';
  url.host = 'container';
  const forwarded = new Request(url, request);
  forwarded.headers.delete('host');
  return forwarded;
}
