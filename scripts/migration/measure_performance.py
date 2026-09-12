#!/usr/bin/env python3
"""Low-concurrency HTTP performance samples. Never records cookies or content."""
import argparse
import datetime
import json
import math
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode


def percentile(values, fraction):
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)] if values else None


def measure(url, samples, fresh=False):
    rows = []
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')
    for index in range(samples):
        target = url
        if fresh:
            parts = urlsplit(url)
            target = urlunsplit(parts._replace(query=urlencode(parse_qsl(parts.query) + [('perf_sample', f'{stamp}-{index}')])) )
        with tempfile.TemporaryDirectory() as directory:
            headers = Path(directory) / 'headers'
            result = subprocess.run(['curl', '-sS', '--compressed', '--max-time', '25',
                '-D', str(headers), '-o', '/dev/null', '-w', '%{json}', target], capture_output=True, text=True)
            if result.returncode:
                rows.append({'error': 'transport', 'exit': result.returncode})
                continue
            metrics = json.loads(result.stdout)
            selected = {}
            for line in headers.read_text().splitlines():
                name, _, value = line.partition(':')
                if name.lower() in {'cf-cache-status', 'server-timing', 'age', 'cache-control', 'x-yohaku-release', 'cf-placement'}:
                    selected[name.lower()] = value.strip()
            rows.append({'status': metrics['http_code'], 'ttfb_ms': round(metrics['time_starttransfer'] * 1000, 2),
                'total_ms': round(metrics['time_total'] * 1000, 2), 'bytes': metrics['size_download'], **selected})
    groups = {}
    for cache in sorted({row.get('cf-cache-status', 'unknown') for row in rows}):
        values = [row['ttfb_ms'] for row in rows if row.get('cf-cache-status', 'unknown') == cache and row.get('status') == 200]
        groups[cache] = {'samples': len(values), 'median_ms': percentile(values, .5),
            'p75_ms': percentile(values, .75) if len(values) >= 20 else None,
            'p95_ms': percentile(values, .95) if len(values) >= 50 else None}
    return {'url': url, 'query_probe': fresh, 'groups': groups, 'samples': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', action='append', required=True)
    parser.add_argument('--samples', type=int, default=20)
    parser.add_argument('--fresh', action='store_true', help='Probe distinct query keys; classify using actual cache headers.')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if not 1 <= args.samples <= 100:
        parser.error('samples must be 1..100')
    for url in args.url:
        parts = urlsplit(url)
        if parts.scheme not in {'https', 'http'} or parts.username or parts.password:
            parser.error('Only credential-free HTTP URLs are allowed')
    data = {'measured_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'kind': 'HTTP only; not browser LCP or interaction timing',
        'routes': [measure(url, args.samples, args.fresh) for url in args.url]}
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps([{'url': route['url'], 'groups': route['groups']} for route in data['routes']], ensure_ascii=False))


if __name__ == '__main__':
    main()
