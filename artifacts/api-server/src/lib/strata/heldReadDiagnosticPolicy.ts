const paths=new Set(['portfolio/balance','portfolio/orders','historical/orders','portfolio/fills',
  'historical/fills','portfolio/positions','portfolio/settlements'].map(p=>'/trade-api/v2/'+p));
export function allowedDiagnosticUrl(raw:string):boolean{
 try{
  const u=new URL(raw);
  if(u.origin!=='https://external-api.kalshi.com'||u.username||u.password||u.hash||!paths.has(u.pathname))return false;
  const allowed=new Set(['subaccount','exchange_index','limit','cursor','settlement_status','count_filter']);
  for(const key of u.searchParams.keys())if(!allowed.has(key)||u.searchParams.getAll(key).length!==1)return false;
  if(u.searchParams.get('subaccount')!=='1'||u.searchParams.get('exchange_index')!=='2')return false;
  if(u.pathname.endsWith('/balance'))return [...u.searchParams.keys()].length===2;
  if(u.searchParams.get('limit')!=='200')return false;
  const cursor=u.searchParams.get('cursor');if(cursor!==null&&(cursor.length===0||cursor.length>4096))return false;
  const status=u.searchParams.get('settlement_status'),count=u.searchParams.get('count_filter');
  return (status===null||status==='all')&&(count===null||count==='position,total_traded');
 }catch{return false;}
}
