#!/usr/bin/env python3
"""Small authenticated, read-only HTTP bridge for an Rdio Scanner SQLite database."""
import argparse, json, mimetypes, os, sqlite3, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

def connection(database):
    return sqlite3.connect("file:" + database + "?mode=ro", uri=True, timeout=5)

class Handler(BaseHTTPRequestHandler):
    server_version = "RdioReadOnlyBridge/1.0"
    def send_json(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.send_header("Cache-Control", "no-store")
        self.end_headers(); self.wfile.write(body)
    def authenticated(self):
        return self.headers.get("Authorization", "") == "Bearer " + self.server.token
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            if not self.authenticated(): return self.send_json(401, {"error":"Unauthorized"})
            return self.send_json(200, {"status":"ok","database":os.path.basename(self.server.database)})
        if not self.authenticated(): return self.send_json(401, {"error":"Unauthorized"})
        if parsed.path == "/calls": return self.calls(parsed)
        parts = parsed.path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "calls" and parts[2] == "audio" and parts[1].isdigit():
            return self.audio(int(parts[1]))
        self.send_json(404, {"error":"Not found"})
    def calls(self, parsed):
        limit = max(1, min(int(parse_qs(parsed.query).get("limit", [25])[0]), 100))
        sql = '''select c.id,c.dateTime,c.system,s.label,c.talkgroup,coalesce(t.label,t.name),
                 c.frequency,c.source,u.label,g.label,x.label,length(c.audio),c.audioType,c.audioName
                 from rdioScannerCalls c left join rdioScannerSystems s on s.id=c.system
                 left join rdioScannerTalkgroups t on t.systemId=c.system and t.id=c.talkgroup
                 left join rdioScannerUnits u on u.systemId=c.system and u.id=c.source
                 left join rdioScannerGroups g on g._id=t.groupId left join rdioScannerTags x on x._id=t.tagId
                 order by c.id desc limit ?'''
        try:
            db=connection(self.server.database); rows=db.execute(sql,(limit,)).fetchall(); db.close()
            keys=("id","dateTime","system","systemLabel","talkgroup","talkgroupLabel","frequency","source","sourceLabel","groupLabel","tagLabel","audioBytes","audioType","audioName")
            calls=[dict(zip(keys,row)) for row in rows]
            for call in calls: call["audioPath"]="/calls/%s/audio"%call["id"]
            self.send_json(200,{"calls":calls,"fetchedAt":int(time.time())})
        except Exception as error: self.send_json(503,{"error":str(error)})
    def audio(self, call_id):
        try:
            db=connection(self.server.database); row=db.execute("select audio,audioName,audioType from rdioScannerCalls where id=?",(call_id,)).fetchone(); db.close()
            if not row or not row[0]: return self.send_json(404,{"error":"Call not found"})
            audio=bytes(row[0]); content_type=row[2] or mimetypes.guess_type(row[1] or "audio.mp3")[0] or "audio/mpeg"
            start,end=0,len(audio)-1; status=200
            range_header=self.headers.get("Range","")
            if range_header.startswith("bytes="):
                values=range_header[6:].split("-",1); start=int(values[0] or 0); end=min(int(values[1] or end),end); status=206
            if start<0 or end<start or start>=len(audio): return self.send_json(416,{"error":"Invalid range"})
            body=audio[start:end+1]; self.send_response(status); self.send_header("Content-Type",content_type)
            self.send_header("Accept-Ranges","bytes"); self.send_header("Content-Length",str(len(body)))
            if status==206: self.send_header("Content-Range",f"bytes {start}-{end}/{len(audio)}")
            self.send_header("Cache-Control","private, max-age=3600"); self.end_headers(); self.wfile.write(body)
        except Exception as error: self.send_json(503,{"error":str(error)})
    def log_message(self, fmt, *args): pass

if __name__ == "__main__":
    parser=argparse.ArgumentParser(); parser.add_argument("--database",required=True); parser.add_argument("--token",default=os.getenv("RDIO_BRIDGE_TOKEN")); parser.add_argument("--listen",default="0.0.0.0"); parser.add_argument("--port",type=int,default=3071)
    args=parser.parse_args()
    if not args.token: parser.error("--token or RDIO_BRIDGE_TOKEN is required")
    server=ThreadingHTTPServer((args.listen,args.port),Handler); server.database=os.path.abspath(args.database); server.token=args.token; server.serve_forever()
