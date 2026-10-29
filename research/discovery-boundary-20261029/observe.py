"""Bounded public GET comparison; never loads credentials or sends orders."""
import concurrent.futures, datetime, json, time, urllib.request
from pathlib import Path

ROOT=Path(__file__).parent
BASE='https://external-api.kalshi.com/trade-api/v2/markets'
START=datetime.datetime.fromisoformat('2026-10-29T00:44:55+00:00').timestamp()
END=START+65
if time.time()>=END:
 raise SystemExit('Capture window elapsed; refusing to overwrite recorded evidence.')
URLS={
 'legacy':BASE+'?series_ticker=KXBTC15M&status=open&limit=100',
 'bounded':BASE+'?series_ticker=KXBTC15M&min_close_ts=1793234701&max_close_ts=1793235600&limit=100',
 'detail':BASE+'/KXBTC15M-26OCT282100-00',
}
def read(pair):
 name,url=pair; began=time.time()
 try:
  # Match the no-cache headers emitted by Node fetch(cache='no-store').
  req=urllib.request.Request(url,headers={'Accept':'application/json','Cache-Control':'no-cache','Pragma':'no-cache'})
  with urllib.request.urlopen(req,timeout=6) as r:
   body=json.load(r)
   rows=body.get('markets',[body['market']] if 'market' in body else [])
   return {'source':name,'started':began,'finished':time.time(),'http':r.status,
    'headers':{k:r.headers.get(k) for k in ('date','cache-control','age','x-kalshi-cache-hits')},
    'markets':[{k:m.get(k) for k in ('ticker','status','open_time','close_time','floor_strike','yes_ask_dollars','no_ask_dollars')} for m in rows]}
 except Exception as e:
  return {'source':name,'started':began,'finished':time.time(),'error':type(e).__name__}

with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
 while time.time()<START: time.sleep(min(1,START-time.time()))
 with (ROOT/'observations.jsonl').open('w') as out:
  while time.time()<END:
   began=time.monotonic()
   for row in pool.map(read,URLS.items()):
    out.write(json.dumps(row)+'\n');out.flush()
    print(json.dumps(row),flush=True)
   time.sleep(max(.1,2-(time.monotonic()-began)))
print('PUBLIC_DISCOVERY_COMPARISON_COMPLETE',flush=True)
