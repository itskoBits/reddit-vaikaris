#!/usr/bin/env python3
"""Build and preview the same static files deployed to GitHub Pages."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from archive import ROOT
from build import build_site


class StaticHandler(SimpleHTTPRequestHandler):
    def list_directory(self, path):
        self.send_error(404)
        return None

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; worker-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'")
        if self.path.split('?', 1)[0].endswith('.json.gz'):
            self.send_header('Cache-Control', 'public, max-age=31536000, immutable')
        else:
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--skip-build', action='store_true', help='Serve the existing dist/ output')
    args = parser.parse_args()
    output = ROOT / 'dist'
    if not args.skip_build:
        print('Building static Reddit archive…', flush=True)
        manifest = build_site(output=output)
        print(f"{manifest['meta']['total']:,} records · {manifest['download_bytes'] / 1_000_000:.2f} MB compressed", flush=True)
    if not (output / 'index.html').exists():
        parser.error('Run python3 build.py first.')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(StaticHandler, directory=str(output)))
    print(f'Static preview: http://localhost:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
