import {V13_CHAMPION_PARAMETER_SET,V13_CHAMPION_PARAMETER_HASH} from "@workspace/v13-strategy";
/** Remaining lifetime of the persisted prepareExit strategy evidence. The age
 * is measured by PostgreSQL; the dispatcher subtracts monotonic elapsed after
 * this read, including COMMIT and signing. Never substitute a newer source.
 * A finite negative result means intact evidence has expired. Null means the
 * evidence is invalid and must not authorize known-no-send cleanup. */
export function protectiveExitSourceRemainingMs(owned:unknown,maxAge:unknown,age:unknown,market:string):number|null {
 if(!owned||typeof owned!=="object"||Array.isArray(owned)||
    typeof maxAge!=="number"||!Number.isSafeInteger(maxAge)||maxAge<=0||maxAge>5000||
    typeof age!=="number"||!Number.isFinite(age)||age<0)return null;
 const o=owned as Record<string,unknown>,s=o.source;
 if(!s||typeof s!=="object"||Array.isArray(s))return null;
 const source=s as Record<string,unknown>;
 if(typeof source.id!=="string"||!source.id||o.sourcePaperEvaluationId!==source.id||
    source.market_ticker!==market||source.feed_freshness!=="current"||
    source.strategy_parameter_set_id!==V13_CHAMPION_PARAMETER_SET.id||
    source.strategy_parameter_hash!==V13_CHAMPION_PARAMETER_HASH||
    typeof source.evaluated_at!=="string"||!Number.isFinite(Date.parse(source.evaluated_at)))return null;
 const ages=["btc_provider_age_ms","btc_receive_age_ms","market_age_ms"].map(k=>source[k]);
 if(!ages.every((x):x is number=>typeof x==="number"&&Number.isFinite(x)&&x>=0))return null;
 const remaining=maxAge-age-Math.max(...ages as number[]);
 return Number.isFinite(remaining)?remaining:null;
}
