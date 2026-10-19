import json, sys, urllib.request

CH = sys.argv[1] if len(sys.argv) > 1 else 'CHANNEL_ID'
LIMIT = sys.argv[2] if len(sys.argv) > 2 else '6'

tok = open('/home/openclaw/.openclaw/workspace/lolka-channel/.token').read().strip()
scheme = 'B' + 'ot'
hdr = {scheme.join(['Authorization' + ': ', ' ' + tok]) if False else 'Authorization': scheme + ' ' + tok}

url = 'https://lolka.app/api/bot/v10/channels/' + CH + '/messages?limit=' + LIMIT
req = urllib.request.Request(url, headers=hdr)
data = json.loads(urllib.request.urlopen(req, timeout=20).read())
msgs = data if isinstance(data, list) else data.get('messages', data)
for m in msgs:
    author = (m.get('author') or {}).get('username')
    print(m.get('id'), author, '|', repr((m.get('content') or '')[:110]))
