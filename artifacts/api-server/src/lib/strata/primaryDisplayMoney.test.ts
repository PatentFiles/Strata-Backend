import assert from "node:assert/strict";
import test from "node:test";
import { normalizePrimaryDisplayMoney, normalizeWalletDisplayMoney } from "./primaryDisplayMoney";
import { normalizeKalshiMoney } from "./kalshiUserRead";

test("valid subcent primary cash keeps exact evidence and floors display only",()=>{
 for (const [raw,cents,micros] of [["100.0001",10000,"100000100"],["0.0099",0,"9900"],["12.3456",1234,"12345600"]] as const) {
  const result=normalizePrimaryDisplayMoney({balance_dollars:raw,portfolio_value:0});
  assert.equal(result.cashCents,cents);assert.equal(result.cashDollarsExact,raw);
  assert.equal(result.cashMicrosExact,micros);assert.equal(result.cashDisplayRoundedDown,true);
  assert.equal(result.cashReadReason,"display_floor_to_cent");assert.equal(result.portfolioValueCents,0);
  assert.equal(normalizeKalshiMoney({balance_dollars:raw}).cashCents,null,"execution parser must remain strict");
 }
});
test("whole-cent dollars, zero and legacy integer cents remain exact",()=>{
 for(const [input,cents] of [[{balance_dollars:"0.0000"},0],[{balance_dollars:"100.0000"},10000],[{balance:2500},2500]] as const){
  const result=normalizePrimaryDisplayMoney(input);assert.equal(result.cashCents,cents);
  assert.equal(result.cashDisplayRoundedDown,false);assert.equal(result.cashReadReason,"exact_cents");
 }
});
test("missing malformed negative excessive precision and unsafe values stay unknown",()=>{
 for(const input of [{},{balance_dollars:"-1.0000"},{balance_dollars:"1.0000001"},{balance_dollars:"NaN"},
  {balance_dollars:100.1},{balance_dollars:"1e2"},{balance_dollars:" 100.00 "},
  {balance_dollars:"wrong",balance:10000},{balance_dollars:"900719925474099.00"},
  {balance:-1},{balance:"25.00"}]) {
  const result=normalizePrimaryDisplayMoney(input);assert.equal(result.cashCents,null);
  assert.equal(result.cashDollarsExact,null);assert.equal(result.cashMicrosExact,null);
 }
});

 test("inherited cash fields are not provider evidence",()=>{
  for(const input of [Object.create({balance_dollars:"100.0001"}),Object.create({balance:10000})])
   assert.equal(normalizePrimaryDisplayMoney(input).cashCents,null);
 });

test("inherited dollars cannot override own legacy cash",()=>{
 const row=Object.assign(Object.create({balance_dollars:"100.00"}),{balance:2500});
 assert.equal(normalizePrimaryDisplayMoney(row).cashCents,2500);
});

test("bot wallet display retains exact post-fee cash without changing financial parser",()=>{
 const raw={balance_dollars:"24.4825",portfolio_value:0};
 const display=normalizeWalletDisplayMoney(raw);
 assert.equal(display.cashCents,2448); assert.equal(display.cashMicrosExact,"24482500");
 assert.equal(display.cashDisplayRoundedDown,true);
 assert.equal(normalizeKalshiMoney(raw).cashCents,null);
});
