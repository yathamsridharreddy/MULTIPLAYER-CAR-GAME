// v64 per-map social preview: shared links with ?map=N get the right OG card.
// Humans are instantly redirected to the real game; crawlers read the tags.
module.exports = (req, res) => {
  const maps = ['highland', 'neon', 'island', 'canyon', 'snow'];
  const names = ['HIGHLAND RUSH', 'NEON CITY', 'ISLAND MOTORFEST', 'CANYON CHICANE', 'HAIRPIN GP'];
  let m = parseInt(req.query.map, 10);
  if (!(m >= 0 && m <= 4)) m = 0;
  const base = 'https://sridhar-drift.vercel.app';
  const img = base + '/img/og-map-' + maps[m] + '.png';
  const u = new URL(req.url, base);
  u.searchParams.delete('map');
  u.searchParams.delete('room');
  const target = base + '/' + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '');
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html><head>' +
    '<meta property="og:title" content="Sridhar Rush — ' + names[m] + '"/>' +
    '<meta property="og:description" content="Your phone is the joystick — race this circuit live."/' + '>' +
    '<meta property="og:image" content="' + img + '"/>' +
    '<meta name="twitter:card" content="summary_large_image"/>' +
    '<script>location.replace(' + JSON.stringify(target) + ');</script>' +
    '</head><body></body></html>');
};
