#!/usr/bin/env python3
"""Authenticated, read-only ThinLine PostgreSQL call-history bridge for PagerMon."""
import argparse
import base64
import datetime
import hmac
import json
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


CALLS_SQL = '''SELECT coalesce(json_agg(row_to_json(recent)), '[]'::json) FROM (
    SELECT c."callId" AS id, c."timestamp" AS "timeMs", c."systemRef" AS system,
      s.label AS "systemLabel", c."talkgroupRef" AS talkgroup,
      coalesce(t.label, t.name) AS "talkgroupLabel", c.frequency,
      cu."unitRef" AS source, cu.label AS "sourceLabel", g.label AS "groupLabel",
      tag.label AS "tagLabel", octet_length(c.audio) AS "audioBytes",
      c."audioMime" AS "audioType", c."audioFilename" AS "audioName"
    FROM calls c
    LEFT JOIN systems s ON s."systemId" = c."systemId"
    LEFT JOIN talkgroups t ON t."talkgroupId" = c."talkgroupId"
    LEFT JOIN tags tag ON tag."tagId" = t."tagId"
    LEFT JOIN LATERAL (
      SELECT cu."unitRef", coalesce(u.label, cu.label) AS label
      FROM "callUnits" cu LEFT JOIN units u
        ON u."systemId" = c."systemId" AND u."unitRef" = cu."unitRef"
      WHERE cu."callId" = c."callId" ORDER BY cu."offset", cu."callUnitId" LIMIT 1
    ) cu ON true
    LEFT JOIN LATERAL (
      SELECT gr.label FROM "talkgroupGroups" tg
      JOIN groups gr ON gr."groupId" = tg."groupId"
      WHERE tg."talkgroupId" = c."talkgroupId" ORDER BY gr."order" LIMIT 1
    ) g ON true
    ORDER BY c."callId" DESC LIMIT {limit}
  ) recent'''

TALKGROUPS_SQL = '''SELECT coalesce(json_agg(row_to_json(channels)), '[]'::json) FROM (
    SELECT s."systemRef" AS system, s.label AS "systemLabel",
      t."talkgroupRef" AS talkgroup, coalesce(t.label, t.name) AS label,
      tag.label AS "tagLabel"
    FROM talkgroups t JOIN systems s ON s."systemId" = t."systemId"
    LEFT JOIN tags tag ON tag."tagId" = t."tagId"
    WHERE coalesce(t.hidden, false) = false
    ORDER BY s.label, t.label, t."talkgroupRef"
  ) channels'''


def query(sql, timeout=10):
    result = subprocess.run(
        ['docker', 'exec', 'thinline-postgres', 'psql', '-U', 'thinline_user',
         '-d', 'thinline_radio', '-At', '-c', sql],
        capture_output=True, text=True, timeout=timeout, check=True)
    return result.stdout.strip()


class Handler(BaseHTTPRequestHandler):
    server_version = 'ThinLineReadOnlyBridge/1.0'

    def send_json(self, status, payload):
        body = json.dumps(payload, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        supplied = self.headers.get('Authorization', '')
        if not hmac.compare_digest(supplied, 'Bearer ' + self.server.token):
            return self.send_json(401, {'error': 'Unauthorized'})
        parsed = urlparse(self.path)
        if parsed.path == '/health':
            try:
                query('SELECT 1', timeout=5)
                return self.send_json(200, {'status': 'ok', 'source': 'thinline'})
            except (subprocess.SubprocessError, OSError):
                return self.send_json(503, {'status': 'unavailable'})
        if parsed.path == '/calls':
            try:
                limit = max(1, min(int(parse_qs(parsed.query).get('limit', ['25'])[0]), 100))
                calls = json.loads(query(CALLS_SQL.format(limit=limit)))
                for call in calls:
                    milliseconds = call.pop('timeMs', None)
                    call['dateTime'] = (datetime.datetime.fromtimestamp(
                        milliseconds / 1000, datetime.timezone.utc).isoformat()
                        if milliseconds else None)
                    call['audioPath'] = '/calls/{}/audio'.format(call['id'])
                return self.send_json(200, {'calls': calls, 'source': 'thinline',
                                            'fetchedAt': int(time.time())})
            except (ValueError, subprocess.SubprocessError, OSError, OverflowError):
                return self.send_json(503, {'error': 'ThinLine history unavailable'})
        if parsed.path == '/talkgroups':
            try:
                return self.send_json(200, {'talkgroups': json.loads(query(TALKGROUPS_SQL)),
                                            'source': 'thinline', 'fetchedAt': int(time.time())})
            except (ValueError, subprocess.SubprocessError, OSError):
                return self.send_json(503, {'error': 'ThinLine talkgroups unavailable'})
        parts = parsed.path.strip('/').split('/')
        if len(parts) == 3 and parts[0] == 'calls' and parts[2] == 'audio' and parts[1].isdigit():
            call_id = int(parts[1])
            if call_id < 1: return self.send_json(400, {'error': 'Invalid call ID'})
            try:
                output = query('SELECT coalesce(encode(audio, \'base64\'), \'\') || \'|\' || '
                               'coalesce("audioMime", \'\') FROM calls WHERE "callId" = {}'.format(call_id), 15)
                if not output: return self.send_json(404, {'error': 'Call not found'})
                encoded, mime = output.split('|', 1)
                if not encoded: return self.send_json(404, {'error': 'Audio unavailable'})
                audio = base64.b64decode(encoded)
                start, end = 0, len(audio) - 1
                status = 200
                header = self.headers.get('Range', '')
                if header:
                    if not header.startswith('bytes=') or ',' in header:
                        return self.send_json(416, {'error': 'Invalid range'})
                    first, separator, last = header[6:].partition('-')
                    if not separator: return self.send_json(416, {'error': 'Invalid range'})
                    if first:
                        start = int(first)
                        end = min(int(last), end) if last else end
                    elif last:
                        start = max(0, len(audio) - int(last))
                    if start > end or start >= len(audio):
                        return self.send_json(416, {'error': 'Invalid range'})
                    status = 206
                body = audio[start:end + 1]
                self.send_response(status)
                self.send_header('Content-Type', mime or 'audio/mpeg')
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'private, max-age=3600')
                if status == 206:
                    self.send_header('Content-Range', 'bytes {}-{}/{}'.format(start, end, len(audio)))
                self.end_headers()
                self.wfile.write(body)
                return
            except (ValueError, subprocess.SubprocessError, OSError):
                return self.send_json(503, {'error': 'ThinLine audio unavailable'})
        self.send_json(404, {'error': 'Not found'})

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--token', default=None)
    parser.add_argument('--listen', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=3072)
    parser.add_argument('--check', action='store_true', help='validate read-only call query and exit')
    args = parser.parse_args()
    if args.check:
        print('ThinLine calls query OK: {} row(s)'.format(len(json.loads(query(CALLS_SQL.format(limit=2))))))
        print('ThinLine talkgroups query OK: {} row(s)'.format(len(json.loads(query(TALKGROUPS_SQL)))))
        raise SystemExit(0)
    import os
    token = args.token or os.getenv('RDIO_BRIDGE_TOKEN')
    if not token: parser.error('A bridge token is required')
    server = ThreadingHTTPServer((args.listen, args.port), Handler)
    server.token = token
    server.serve_forever()
