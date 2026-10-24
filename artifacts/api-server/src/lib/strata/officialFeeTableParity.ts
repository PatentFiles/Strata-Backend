/**
 * Kalshi issuer PDF fee table/formula parity (#165).
 * The monetary coefficients are parsed from current issuer bytes elsewhere;
 * these public worked examples independently test the same current document.
 * No source pin, trade authority, DB write, price or policy override.
 */
const SAMPLE_PRICE_CENTS=[1,5,10,25,50,75,90,99] as const;
const CENTS_DENOMINATOR=100_000_000n;
const exactMoney=(cents:number)=>"$"+(cents/100|0)+"."+(cents%100).toString().padStart(2,"0");
export function issuerWholeCentFee(ratePpm:number,contracts:number,priceCents:number):number|null{
 if(![ratePpm,contracts,priceCents].every(Number.isSafeInteger)||
   ratePpm<0||ratePpm>1_000_000||contracts<1||contracts>10_000||
   priceCents<1||priceCents>99)return null;
 const numerator=BigInt(ratePpm)*BigInt(contracts)*
   BigInt(priceCents)*BigInt(100-priceCents);
 const cents=(numerator+CENTS_DENOMINATOR-1n)/CENTS_DENOMINATOR;
 return cents<=BigInt(Number.MAX_SAFE_INTEGER)?Number(cents):null;
}
/** A positive observation requires the issuer's own one/100-contract examples
 * to agree with its current formula at whole-cent table rounding.
 * These are consistency witnesses, not a claim that every fractional fill
 * must round to a full cent; Kalshi's own text says centicent for such fills.
 */
export function verifyIssuerGeneralFeeTable(doc:string,takerRatePpm:number):{
 ok:true;checkedPriceCents:readonly number[]
}|{ok:false;reason:string}{
 if(typeof doc!=="string"||doc.length>500_000||
    !Number.isSafeInteger(takerRatePpm)||takerRatePpm<0||takerRatePpm>1_000_000)
    return {ok:false,reason:"official_fee_reference_table_invalid"};
 const beginning=doc.indexOf("General Trading Fees Table");
 const ending=beginning>=0?doc.indexOf("Non-Standard Fees",beginning):-1;
 if(beginning<0||ending<=beginning||ending-beginning>30_000)
    return {ok:false,reason:"official_fee_reference_table_missing_or_reordered"};
 const table=doc.slice(beginning,ending).replace(/\s+/g," ");
 for(const p of SAMPLE_PRICE_CENTS){
   const one=issuerWholeCentFee(takerRatePpm,1,p);
   const hundred=issuerWholeCentFee(takerRatePpm,100,p);
   if(one===null||hundred===null)return {ok:false,reason:"official_fee_reference_arithmetic_invalid"};
   const expected=[exactMoney(p),exactMoney(one),exactMoney(p*100),exactMoney(hundred)];
   const pattern=new RegExp(expected.map(x=>x.replace(/[.$]/g,"\\$&")).join("\\s+"),"g");
   const occurrences=[...table.matchAll(pattern)].length;
   if(occurrences!==1)return {ok:false,reason:"official_fee_reference_table_formula_mismatch"};
 }
 return {ok:true,checkedPriceCents:SAMPLE_PRICE_CENTS};
}
