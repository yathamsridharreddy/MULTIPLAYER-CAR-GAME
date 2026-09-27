#!/usr/bin/env python3
"""Static server for tools/ui-preview/*.html, rooted at the repository root.

Why it exists: this sandbox has no browser (the Playwright browser CDN is
blocked), so a UI change can only be checked by rendering a picture by hand. This
serves the real stylesheet, the real markup and the real script to the reviewer's
OWN browser instead - no mock-up, nothing to drift.

    python3 tools/ui-preview/serve.py [port]      # default 8080

GET /  ->  tools/ui-preview/weather-row.html
"""
import http.server
import os
import socketserver
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
LANDING = '/tools/ui-preview/weather-row.html'


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        if self.path in ('/', '/index.html'):
            self.path = LANDING
        return super().do_GET()

    def end_headers(self):
        # always show the current file: this is a review tool, not a cache demo
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write('[ui-preview] ' + (fmt % args) + '\n')


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('0.0.0.0', port), Handler) as httpd:
        print('ui-preview serving %s on http://0.0.0.0:%d%s' % (ROOT, port, LANDING))
        httpd.serve_forever()


if __name__ == '__main__':
    main()
