/** OFFLINE/OFF-BY-DEFAULT CANDIDATE. No runtime imports, network, credentials, DB, or orders.
 * Policy values below are caller-supplied research parameters, NOT approved production policy.
 */
import {createHash} from 'node:crypto';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const time=x=>Number.isSafeInteger(x)&&x>=0;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=reason=>({ok:false,reason});
export class StrikeSupplement {
 #mode;#policy;#scope=null;#generation=null;#sid=null;#seq=null;#lastFrame=null;#lastSent=null;#tuple=null;#poison=false;#now=-1;
 constructor({mode='OFF',policy=null}={}){this.#mode=mode;this.#policy=policy?Object.freeze({...policy}):null;}
 #clock(now){if(!time(now)||now<this.#now){this.#poison=true;return false;}this.#now=now;return true;}
 configureIdentity(r,now){
  if(!this.#clock(now))return fail('clock');
  if(!r||!/^KXBTC15M-[A-Z0-9-]+$/.test(r.ticker)||r.series!=='KXBTC15M'||typeof r.event!=='string'||!r.event.startsWith('KXBTC15M-')||!r.ticker.startsWith(r.event+'-')||
   r.exchangeIndex!==2||r.strikeType!=='greater_or_equal'||!time(r.openMs)||r.openMs%900000!==0||
   r.closeMs!==r.openMs+900000||!time(r.receivedAtMs)||r.receivedAtMs>now||
   !['open','active','initialized'].includes(r.status)||now>=r.closeMs)return this.#scope?this.#invalidate('rest_identity_invalidated'):fail('rest_identity_unverified');
  const scope=Object.freeze({...r});
  if(this.#scope&&hash({...this.#scope,receivedAtMs:0,status:''})!==hash({...scope,receivedAtMs:0,status:''})){
   this.#poison=true;return fail('scope_change');
  }
  this.#scope=scope;return {ok:true};
 }
 subscribe({generation,sid,now}){
  if(!this.#clock(now)||!Number.isSafeInteger(generation)||generation<1||!Number.isSafeInteger(sid)||sid<0)return fail('subscription');
  // A lost generation cannot establish that no correction occurred. Poison persists for this window.
  if(this.#generation!==null){this.#poison=true;return fail('generation_change');}
  this.#generation=generation;this.#sid=sid;return {ok:true};
 }
 invalidate(){this.#poison=true;this.#generation=null;}
 ingest(f,now){
  if(!this.#clock(now)||this.#poison)return fail('invalidated');
  if(this.#lastFrame!==null&&time(this.#policy?.maxSilenceMs)&&now-this.#lastFrame>this.#policy.maxSilenceMs)return this.#invalidate('stream_silence');
  if(!f||f.generation!==this.#generation||f.sid!==this.#sid||!Number.isSafeInteger(f.seq)||f.seq<0)return this.#invalidate('envelope');
  if(this.#seq!==null&&f.seq!==this.#seq+1)return this.#invalidate('sequence_discontinuity');
  if(!['metadata_updated','created','activated','deactivated','close_date_updated','event_lifecycle','event_fee_update'].includes(f.kind))return this.#invalidate('unknown_progress_frame');
  if(!time(this.#policy?.progressMaxAgeMs)||!time(f.sentAtMs)||f.sentAtMs>now||now-f.sentAtMs>this.#policy.progressMaxAgeMs)return this.#invalidate('progress_timestamp');
  this.#seq=f.seq;this.#lastFrame=now; // Fresh observed baseline only; no historical replay.
  if(['event_lifecycle','event_fee_update'].includes(f.kind)||f.ticker===this.#scope?.ticker&&['deactivated','close_date_updated'].includes(f.kind))return this.#invalidate('lifecycle_change');
  if(f.kind!=='metadata_updated'||f.ticker!==this.#scope?.ticker)return {ok:true,admitted:false};
  if(this.#tuple&&(Object.hasOwn(f,'floor')&&f.floor!==this.#tuple.floor||Object.hasOwn(f,'strikeType')&&f.strikeType!==this.#tuple.strikeType||f.cap!=null))return this.#invalidate('partial_or_full_strike_correction');
  const s=this.#scope,p=this.#policy;
  if(f.exchangeIndex!==undefined&&f.exchangeIndex!==s.exchangeIndex||f.openMs!==undefined&&f.openMs!==s.openMs||f.closeMs!==undefined&&f.closeMs!==s.closeMs)return this.#invalidate('explicit_scope_conflict');
  if(!p||!time(p.admissionMaxAgeMs)||!time(f.sentAtMs)||f.sentAtMs>now||now-f.sentAtMs>p.admissionMaxAgeMs||this.#lastSent!==null&&f.sentAtMs<this.#lastSent)return this.#invalidate('source_timestamp');
  if(f.strikeType!==s.strikeType||!finite(f.floor)||f.floor<=0||f.cap!=null)return fail('incomplete_tuple');
  if(now<s.openMs||now>=s.closeMs)return fail('wrong_window');
  if(this.#tuple&&this.#tuple.floor!==f.floor)return this.#invalidate('strike_correction');
  this.#lastSent=f.sentAtMs;
  if(!this.#tuple)this.#tuple=Object.freeze({ticker:s.ticker,openMs:s.openMs,closeMs:s.closeMs,exchangeIndex:2,
   strikeType:s.strikeType,floor:f.floor,generation:f.generation,sid:f.sid,seq:f.seq,sentAtMs:f.sentAtMs,receivedAtMs:now,policyHash:p.hash});
  return {ok:true,admitted:true};
 }
 #invalidate(reason){this.#poison=true;return fail(reason);}
 select(quote,now){
  if(!this.#clock(now)||this.#poison)return fail('invalidated');
  if(this.#mode!=='SHADOW')return fail('source_off'); // ACTIVE deliberately unsupported.
  const p=this.#policy,t=this.#tuple,s=this.#scope;
  if(!p||!/^([a-f0-9]{64})$/.test(p.hash)||!time(p.maxSilenceMs)||p.maxSilenceMs===0||!time(p.maxMetadataAgeMs)||p.maxMetadataAgeMs===0)return fail('policy_unreviewed_or_missing');
  if(!t||!s||this.#generation!==t.generation||this.#lastFrame===null)return fail('source_unavailable');
  if(now>=s.closeMs||now-this.#lastFrame>p.maxSilenceMs||now-t.sentAtMs>p.maxMetadataAgeMs)return this.#invalidate('metadata_lease_expired');
  if(!quote||quote.ticker!==s.ticker||quote.exchangeIndex!==2||quote.openMs!==s.openMs||quote.closeMs!==s.closeMs||!['open','active'].includes(quote.status))return fail('quote_scope');
  if(!time(quote.fetchedAtMs)||quote.fetchedAtMs>now||now-quote.fetchedAtMs>5000||!time(quote.btcAtMs)||quote.btcAtMs>now||now-quote.btcAtMs>5000)return fail('quote_stale');
  if(!finite(quote.yesAsk)||!finite(quote.noAsk)||quote.yesAsk<=0||quote.yesAsk>=1||quote.noAsk<=0||quote.noAsk>=1)return fail('quote_unavailable');
  if(quote.restStrike!=null&&quote.restStrike!==t.floor)return this.#invalidate('rest_strike_conflict');
  const provenance=Object.freeze({...t,digest:hash(t)});
  return Object.freeze({ok:true,tradingAuthority:false,qualification:'SHADOW_ONLY',target:t.floor,provenance,
   fetchedAtMs:quote.fetchedAtMs,btcAtMs:quote.btcAtMs,yesAsk:quote.yesAsk,noAsk:quote.noAsk});
 }
 validatePublished(provenance,quote,now){const v=this.select(quote,now);if(!v.ok)return v;
  return provenance?.digest===v.provenance.digest&&hash(Object.fromEntries(Object.entries(provenance).filter(([k])=>k!=='digest')))===provenance.digest?v:fail('provenance_changed');}
}

/** Research-only parser for an ALREADY verified account/host + existing REST evidence bundle.
 * Boolean binding below remains a fixture contract, never production authentication.
 * Mirrors existing fee reader's series/event/optional market-index relationship; not fee approval.
 */
export function normalizedRestIdentity({market,event,series,context,receivedAtMs}){
 if(!market||!event||!series||!context||context.host!=='https://external-api.kalshi.com'||
  context.accountBindingVerified!==true||context.exchangeIndex!==2||
  series.ticker!=='KXBTC15M'||series.exchange_index!==2||event.series_ticker!=='KXBTC15M'||
  typeof market.event_ticker!=='string'||market.event_ticker!==event.event_ticker||
  market.exchange_index!==undefined&&market.exchange_index!==2||event.exchange_index!==undefined&&event.exchange_index!==2)
  return fail('series_event_account_binding');
 return {ok:true,identity:Object.freeze({ticker:market.ticker,event:market.event_ticker,series:series.ticker,
  exchangeIndex:series.exchange_index,strikeType:market.strike_type,openMs:Date.parse(market.open_time),
  closeMs:Date.parse(market.close_time),status:market.status,receivedAtMs})};
}
