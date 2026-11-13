import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import {readFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import type {IRouter, RequestHandler} from 'express';
import {createLocalJWKSet, exportJWK, generateKeyPair, SignJWT} from 'jose';

// Exercise actual Express routing and real JWT verification without a listener.
let networkAttempts = 0;
const denyNetwork = () => {networkAttempts++; throw Error('offline_network_forbidden');};
net.Socket.prototype.connect = denyNetwork as never;
net.Server.prototype.listen = denyNetwork as never;
tls.connect = denyNetwork as never;
http.request = http.get = denyNetwork as never;
https.request = https.get = denyNetwork as never;
dns.lookup = denyNetwork as never;
globalThis.fetch = denyNetwork as never;
after(() => assert.equal(networkAttempts, 0, 'the suite must make zero network attempts'));
process.env.DATABASE_URL = 'postgresql://offline:offline@127.0.0.1:1/offline';

const imports = Promise.all([
 import('./ownerUnknownRecoveryRouter'), import('./strataRouter'),
 import('../lib/strata/supabaseAuth'), import('../lib/strata/ownerUnknownRecoveryService'),
 import('../lib/strata/ownerUnknownRecoveryPlan'),
]);
const supabaseUrl = 'https://synthetic-project.supabase.co';
const owner = '11111111-1111-4111-8111-111111111111';
const foreignOwner = '99999999-9999-4999-8999-999999999999';
const target = '22222222-2222-4222-8222-222222222222';
const receipt = '33333333-3333-4333-8333-333333333333';
const prefix = '/me/unknown-accounting';
type Row = Record<string, unknown>;
type Response = {status: number; body: Row; headers: Record<string, string>};

// No network, supertest, listen(), or HTTP request is used. Express Router.handle
// receives precisely the request/res.locals semantics used by the middleware.
function dispatch(router: IRouter, path: string, method = 'GET', authorization?: string, body?: unknown): Promise<Response> {
 return new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('in_process_dispatch_timed_out')), 4000);
  const headers: Record<string, string> = {};
  const req = {method, url: path, originalUrl: path, baseUrl: '', body, headers: authorization ? {authorization} : {},
   header(name: string) {return (this.headers as Record<string, string>)[name.toLowerCase()];}};
  const res = {locals: {}, statusCode: 200, headersSent: false,
   setHeader(name: string, value: string) {headers[name.toLowerCase()] = value; return this;},
   status(code: number) {this.statusCode = code; return this;},
   json(value: unknown) {this.headersSent = true; clearTimeout(timer);
    // JSON serialization here catches accidental BigInt or cyclic response data.
    try {resolve({status: this.statusCode, body: JSON.parse(JSON.stringify(value)) as Row, headers});}
    catch (error) {reject(error);} return this;},
  };
  const done = (error?: unknown) => {clearTimeout(timer); error ? reject(error) :
   resolve({status: 404, body: {error: 'not_found'}, headers});};
  try {(router as unknown as {handle(req: unknown, res: unknown, done: (error?: unknown) => void): void}).handle(req, res, done);}
  catch (error) {clearTimeout(timer); reject(error);}
 });
}

const keysPromise = (async () => {
 const pair = await generateKeyPair('RS256');
 const foreignPair = await generateKeyPair('RS256');
 const publicJwk = await exportJWK(pair.publicKey);
 publicJwk.alg = 'RS256'; publicJwk.use = 'sig';
 return {pair, foreignPair, keys: createLocalJWKSet({keys: [publicJwk]})};
})();

async function token(options: {sub?: string | null; aal?: string | null; issuer?: string; audience?: string;
 expires?: number | null; foreignSignature?: boolean; futureNotBefore?: boolean} = {}) {
 const {pair, foreignPair} = await keysPromise;
 const jwt = new SignJWT({...(options.aal === null ? {} : {aal: options.aal ?? 'aal2'}), role: 'authenticated'})
  .setProtectedHeader({alg: 'RS256'}).setIssuer(options.issuer ?? `${supabaseUrl}/auth/v1`)
  .setAudience(options.audience ?? 'authenticated').setIssuedAt();
 if (options.sub !== null) jwt.setSubject(options.sub ?? owner);
 if (options.expires !== null) jwt.setExpirationTime(options.expires ?? Math.floor(Date.now()/1000) + 600);
 if (options.futureNotBefore) jwt.setNotBefore(Math.floor(Date.now()/1000) + 600);
 return jwt.sign(options.foreignSignature ? foreignPair.privateKey : pair.privateKey);
}

async function harness(options: {missingPort?: boolean; actualService?: boolean; roleFailure?: boolean;
 output?: Row; throwing?: boolean} = {}) {
 const [{createOwnerUnknownRecoveryRouter}, {createStrataRouter}, {createStrataAccess, verifySupabaseAccessToken},
  {createOwnerUnknownRecoveryService}, plan] = await imports;
 const {keys} = await keysPromise;
 const calls = {roles: [] as string[], actions: [] as {action: string; ownerId: string; body: unknown}[],
  db: [] as {sql: string; args: unknown[]}[], material: 0, feeds: 0, connects: 0};
 const auth = {
  verifyToken: (value: string) => verifySupabaseAccessToken(value, {supabaseUrl, keys}),
  roleOf: async (subject: string) => {calls.roles.push(subject); if (options.roleFailure) throw Error('profile_secret'); return 'STANDARD';},
 };
 const output: Row = options.output ?? {ok: true, accountingCommitted: false, ordersSubmitted: false,
  workerStarted: false, tradingAuthorized: false, riskFreezeCleared: false};
 const port = options.missingPort ? undefined : options.actualService ? createOwnerUnknownRecoveryService({
  db: {query: async (sql: string, args: unknown[]) => {calls.db.push({sql, args}); return {rows: []};},
   connect: async () => {calls.connects++; throw Error('unreachable_transaction');}},
  now: Date.now, isScheduled: () => false,
  material: async () => {calls.material++; throw Error('unreachable_signer');},
  readFeeds: async () => {calls.feeds++; throw Error('unreachable_provider');},
 } as never) : Object.fromEntries(['fence', 'reconcile', 'receipt'].map(action => [action, async (ownerId: string, body: unknown) => {
  calls.actions.push({action, ownerId, body});
  if (options.throwing) throw Error('database_password=never-expose synthetic-private-key');
  return output;
 }]));
 const requireUser = createStrataAccess(auth).requireUser;
 const router = createStrataRouter({...auth,
  control: {start: async () => {throw Error('worker_start_forbidden');}, stop: async () => {throw Error('worker_stop_forbidden');}, view: () => ({})},
  status: async () => ({}), positions: async () => ({}), orders: async () => ({}), fills: async () => ({}),
  trades: async () => ({}), latestTrade: async () => ({}), forwardTestStatus: async () => ({}),
  forwardTestHistory: async () => ({}), phase4State: async () => ({}), microLiveState: async () => ({}),
  emergencyStop: async () => {throw Error('emergency_stop_forbidden');}, unknownAccountingRecovery: port,
 } as never);
 return {router, port, requireUser, calls, createOwnerUnknownRecoveryRouter,
  fence: {targetIntentId: target, confirmation: plan.OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION,
   protectiveAutomationAcknowledgment: (await imports)[3].OWNER_UNKNOWN_PROTECTION_ACKNOWLEDGMENT},
  reconcile: {targetIntentId: target, fenceReceiptId: receipt, confirmation: plan.OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION}};
}

for (const [name, options] of [
 ['AAL1', {aal: 'aal1'}], ['missing AAL', {aal: null}], ['wrong issuer', {issuer: 'https://attacker.invalid/auth/v1'}],
 ['wrong audience', {audience: 'anon'}], ['expired', {expires: Math.floor(Date.now()/1000) - 10}],
 ['missing expiration', {expires: null}], ['missing subject', {sub: null}], ['malformed subject', {sub: 'someone'}],
 ['foreign signature', {foreignSignature: true}], ['future not-before', {futureNotBefore: true}],
] as const) test(`real Supabase verifier rejects ${name} at every recovery endpoint before role/port access`, async () => {
 const h = await harness();
 const bearer = `Bearer ${await token(options)}`;
 for (const [path, method, body] of [[prefix, 'GET', undefined], [prefix+'/fence', 'POST', h.fence],
  [prefix+'/reconcile', 'POST', h.reconcile], [prefix+'/receipts/'+receipt, 'GET', undefined]] as const) {
  const r = await dispatch(h.router, path, method, bearer, body);
  assert.equal(r.status, 401, JSON.stringify(r));
 }
 assert.deepEqual(h.calls.roles, []);
 assert.deepEqual(h.calls.actions, []);
});

for (const authorization of [undefined, 'Basic abc', 'Bearer malformed.token', 'Bearer a b', '']) {
 test(`missing/malformed authorization ${String(authorization)} cannot reach recovery`, async () => {
  const h = await harness();
  const r = await dispatch(h.router, prefix+'/fence', 'POST', authorization, h.fence);
  assert.equal(r.status, 401);
  assert.deepEqual(h.calls.actions, []);
  assert.deepEqual(h.calls.roles, []);
 });
}

test('STANDARD AAL2 owner reaches only their identity through full strataRouter mount and sees safety warning', async () => {
 const h = await harness();
 const auth = `Bearer ${await token()}`;
 const help = await dispatch(h.router, prefix, 'GET', auth);
 assert.equal(help.status, 200);
 assert.match(String(help.body.warning), /KILL halts protective automation/);
 assert.match(String(help.body.warning), /does not cancel orders or liquidate positions/);
 assert.equal(help.body.executionMustRemainKilled, true);
 assert.equal(help.body.restartAuthorized, false);
 assert.equal(help.headers['cache-control'], 'no-store');
 assert.match(String(help.body.uncertainOutcomeInstruction), /missing receipt does not prove rollback/);
 for (const action of ['fence', 'reconcile'] as const) {
  const r = await dispatch(h.router, prefix+'/'+action+'?ownerId='+foreignOwner, 'POST', auth, h[action]);
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
 }
 const receiptResult = await dispatch(h.router, prefix+'/receipts/'+receipt, 'GET', auth);
 assert.equal(receiptResult.status, 200);
 assert.deepEqual(h.calls.actions.map(x => [x.action, x.ownerId]), [['fence', owner], ['reconcile', owner], ['receipt', owner]]);
 assert.deepEqual(h.calls.actions[2]!.body, receipt);
});

test('STANDARD owner cannot reach existing developer production controls through recovery routing', async () => {
 const h = await harness();
 const r = await dispatch(h.router, '/production/start', 'POST', `Bearer ${await token()}`, {});
 assert.equal(r.status, 403);
 assert.deepEqual(h.calls.actions, []);
});

test('profile lookup failure denies recovery before service access', async () => {
 const h = await harness({roleFailure: true});
 const r = await dispatch(h.router, prefix+'/fence', 'POST', `Bearer ${await token()}`, h.fence);
 assert.equal(r.status, 503);
 assert.deepEqual(h.calls.actions, []);
 assert.equal(JSON.stringify(r.body).includes('profile_secret'), false);
});

test('absent integration dependency returns 503 for mutations and receipt without falling back to ambient capabilities', async () => {
 const h = await harness({missingPort: true});
 const auth = `Bearer ${await token()}`;
 for (const [path, method, body] of [[prefix+'/fence', 'POST', h.fence], [prefix+'/reconcile', 'POST', h.reconcile],
  [prefix+'/receipts/'+receipt, 'GET', undefined]] as const) {
  const r = await dispatch(h.router, path, method, auth, body);
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, 'recovery_service_unavailable');
 }
 assert.deepEqual(h.calls.actions, []);
});

test('middleware that fails to set a verified subject cannot invoke the service', async () => {
 const h = await harness();
 const noIdentity: RequestHandler = (_req, _res, next) => next();
 const router = h.createOwnerUnknownRecoveryRouter(noIdentity, h.port as never);
 for (const [path, method, body] of [['/fence', 'POST', h.fence], ['/reconcile', 'POST', h.reconcile],
  ['/receipts/'+receipt, 'GET', undefined]] as const) {
  assert.equal((await dispatch(router, path, method, undefined, body)).status, 401);
 }
 assert.deepEqual(h.calls.actions, []);
});

for (const action of ['fence', 'reconcile'] as const) test(`authenticated ${action} rejects malformed and owner/account/evidence overrides before DB/signer/provider`, async () => {
 const h = await harness({actualService: true});
 const auth = `Bearer ${await token()}`;
 for (const body of [undefined, null, [], 'not-json-object', {}, {...h[action], ownerId: foreignOwner},
  {...h[action], accountId: 'foreign-account'}, {...h[action], evidence: {authenticated: true}},
  {...h[action], privateKey: 'synthetic-secret'}, {...h[action], cashMicros: '0'}, {...h[action], restart: true}]) {
  const r = await dispatch(h.router, prefix+'/'+action, 'POST', auth, body);
  assert.equal(r.status, 409, JSON.stringify(r));
  assert.equal(r.body.ok, false);
 }
 assert.deepEqual(h.calls.db, []);
 assert.equal(h.calls.material, 0);
 assert.equal(h.calls.feeds, 0);
 assert.equal(h.calls.connects, 0);
});

test('foreign target or receipt cannot select a different account; only verified owner is bound into SQL', async () => {
 const h = await harness({actualService: true});
 const auth = `Bearer ${await token({sub: foreignOwner})}`;
 for (const [path, method, body] of [[prefix+'/fence', 'POST', h.fence], [prefix+'/reconcile', 'POST', h.reconcile],
  [prefix+'/receipts/'+receipt, 'GET', undefined]] as const) {
  const r = await dispatch(h.router, path, method, auth, body);
  assert.equal(r.status, 409);
  assert.equal(r.body.ok, false);
 }
 assert.equal(h.calls.db.length, 3);
 for (const call of h.calls.db) {
  assert.equal(call.args[0], foreignOwner);
  assert.match(call.sql, /owner_user_id=\$1::uuid/);
 }
 assert.equal(h.calls.connects, 0);
 assert.equal(h.calls.material, 0);
 assert.equal(h.calls.feeds, 0);
});

test('public response sanitizes nested secrets, credentials, tokens, PEM blobs and dates', async () => {
 const h = await harness({output: {ok: true, reason: 'synthetic_result', privateKey: 'secret', api_key: 'secret',
  authorization: 'Bearer secret', token: 'secret', nested: {password: 'secret', safe: 'visible'},
  list: [{database_url: 'secret', safe: 'still-visible'}],
  blob: '-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----', observedAt: new Date('2026-11-09T00:00:00Z')}});
 const r = await dispatch(h.router, prefix+'/fence', 'POST', `Bearer ${await token()}`, h.fence);
 assert.equal(r.status, 200);
 assert.equal(JSON.stringify(r.body).includes('secret'), false);
 assert.deepEqual(r.body.nested, {safe: 'visible'});
 assert.deepEqual(r.body.list, [{safe: 'still-visible'}]);
 assert.equal(r.body.blob, '[redacted]');
 assert.equal(r.body.observedAt, '2026-11-09T00:00:00.000Z');
});

for (const action of ['fence', 'reconcile', 'receipt'] as const) test(`${action} thrown outcome stays generic and uncertain with no automatic replay`, async () => {
 const h = await harness({throwing: true});
 const r = await dispatch(h.router, prefix+(action === 'receipt' ? '/receipts/'+receipt : '/'+action),
  action === 'receipt' ? 'GET' : 'POST', `Bearer ${await token()}`, action === 'receipt' ? undefined : h[action]);
 assert.equal(r.status, 503);
 assert.equal(r.body.ok, false);
 assert.equal(r.body.outcomeUnknown, true);
 assert.equal(r.body.retryAuthorized, false);
 assert.equal(h.calls.actions.length, 1);
 assert.equal(JSON.stringify(r.body).includes('never-expose'), false);
});

test('uncertain COMMIT result is returned once with its receipt and cannot imply successful accounting', async () => {
 const h = await harness({output: {ok: false, reason: 'recovery_accounting_commit_outcome_unverified',
  accountingCommitted: null, outcomeUnknown: true, receiptId: receipt, retryAuthorized: false,
  ordersSubmitted: false, workerStarted: false, tradingAuthorized: false, riskFreezeCleared: false}});
 const r = await dispatch(h.router, prefix+'/reconcile', 'POST', `Bearer ${await token()}`, h.reconcile);
 assert.equal(r.status, 409);
 assert.equal(r.body.accountingCommitted, null);
 assert.equal(r.body.outcomeUnknown, true);
 assert.equal(r.body.receiptId, receipt);
 assert.equal(r.body.retryAuthorized, false);
 assert.equal(h.calls.actions.length, 1);
});


test('production composition binds recovery only to the shared owner worker registry and existing restricted signed reader', () => {
 const local = resolve(process.cwd(), 'src/routes/strata.ts');
 const source = readFileSync(existsSync(local) ? local : resolve(process.cwd(), 'artifacts/api-server/src/routes/strata.ts'), 'utf8');
 assert.match(source, /import\s*\{\s*createOwnerUnknownRecoveryService\s*\}\s*from\s*["']\.\.\/lib\/strata\/ownerUnknownRecoveryService["']/);
 assert.match(source, /import\s*\{\s*loadedMaterial\s*\}\s*from\s*["']\.\.\/lib\/strata\/inAppProtectiveRelease["']/);
 assert.match(source, /import\s*\{\s*readOwnedKalshiFeeds\s*\}\s*from\s*["']\.\.\/lib\/strata\/personalExchangeRead["']/);
 assert.match(source, /unknownAccountingRecovery:\s*createOwnerUnknownRecoveryService\(\{\s*db:\s*pool,\s*now:\s*Date\.now,\s*isScheduled:\s*\(owner,\s*account\)\s*=>\s*personalTradingSession\.isScheduled\(owner,\s*account\),\s*material:\s*loadedMaterial,\s*readFeeds:\s*readOwnedKalshiFeeds,?\s*\}\)/);
 assert.match(source, /return verifySupabaseAccessToken\(token,\s*\{\s*supabaseUrl:\s*url,\s*keys:\s*keysFor\(url\)\s*\}\)/);
});
