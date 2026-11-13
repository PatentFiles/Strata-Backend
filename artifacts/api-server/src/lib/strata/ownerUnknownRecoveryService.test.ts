import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';

// No listener, DNS lookup, provider or database socket is allowed in this suite.
let networkAttempts = 0;
const denyNetwork = () => { networkAttempts++; throw new Error('offline_network_forbidden'); };
net.Socket.prototype.connect = denyNetwork as never;
net.Server.prototype.listen = denyNetwork as never;
tls.connect = denyNetwork as never;
http.request = http.get = denyNetwork as never;
https.request = https.get = denyNetwork as never;
dns.lookup = denyNetwork as never;
globalThis.fetch = denyNetwork as never;
after(() => assert.equal(networkAttempts, 0, 'the suite must make zero network attempts'));

const imports = Promise.all([import('./ownerUnknownRecoveryService'), import('./ownerUnknownRecoveryPlan')]);
const owner = '11111111-1111-4111-8111-111111111111';
const other = '99999999-9999-4999-8999-999999999999';
const target = '22222222-2222-4222-8222-222222222222';
const receiptId = '33333333-3333-4333-8333-333333333333';
const accountId = 'synthetic-account';
const now = Date.parse('2026-11-09T00:00:00Z');
type Row = Record<string, unknown>;

async function input() {
 const [service, plan] = await imports;
 return {fence: {targetIntentId: target, confirmation: plan.OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION,
  protectiveAutomationAcknowledgment: service.OWNER_UNKNOWN_PROTECTION_ACKNOWLEDGMENT},
 reconcile: {targetIntentId: target, fenceReceiptId: receiptId, confirmation: plan.OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION}};
}

async function closedFixture() {
 const [{createOwnerUnknownRecoveryService}] = await imports;
 const calls = {queries: 0, connects: 0, scheduled: 0, material: 0, feeds: 0};
 const deps = {
  db: {query: async () => {calls.queries++; throw Error('unexpected_database_query');},
   connect: async () => {calls.connects++; throw Error('unexpected_database_connection');}},
  now: () => now, isScheduled: () => {calls.scheduled++; return false;},
  material: async () => {calls.material++; throw Error('unexpected_signer_access');},
  readFeeds: async () => {calls.feeds++; throw Error('unexpected_provider_access');},
 };
 return {service: createOwnerUnknownRecoveryService(deps as never), calls, deps};
}

for (const action of ['fence', 'reconcile'] as const) {
 for (const invalid of ['undefined', 'null', 'array', 'string', 'missing-confirmation', 'wrong-confirmation',
  'invalid-target', 'owner-override', 'account-override', 'signed-evidence', 'cash-override', 'credential',
  'restart', 'arbitrary-field', 'wrong-action-field'] as const) {
  test(`${action}: rejects ${invalid} before all dependencies`, async () => {
   const f = await closedFixture();
   const bodies = await input();
   let body: unknown = {...bodies[action]};
   if (invalid === 'undefined') body = undefined;
   else if (invalid === 'null') body = null;
   else if (invalid === 'array') body = [body];
   else if (invalid === 'string') body = JSON.stringify(body);
   else {
    const b = body as Row;
    if (invalid === 'missing-confirmation') delete b.confirmation;
    if (invalid === 'wrong-confirmation') b.confirmation = true;
    if (invalid === 'invalid-target') b.targetIntentId = "x' OR true --";
    if (invalid === 'owner-override') b.ownerId = other;
    if (invalid === 'account-override') b.accountId = 'foreign-account';
    if (invalid === 'signed-evidence') b.snapshot = {authenticated: true};
    if (invalid === 'cash-override') b.cashMicros = '25000000';
    if (invalid === 'credential') b.privateKey = 'synthetic-secret';
    if (invalid === 'restart') b.restart = true;
    if (invalid === 'arbitrary-field') b.extra = null;
    if (invalid === 'wrong-action-field') b[action === 'fence' ? 'fenceReceiptId' : 'protectiveAutomationAcknowledgment'] = receiptId;
   }
   const result = await f.service[action](owner, body);
   assert.equal(result.ok, false);
   assert.deepEqual(f.calls, {queries: 0, connects: 0, scheduled: 0, material: 0, feeds: 0});
  });
 }
 test(`${action}: invalid authenticated identity cannot be replaced by body identity`, async () => {
  const f = await closedFixture();
  assert.equal((await f.service[action]('not-a-uuid', (await input())[action])).ok, false);
  assert.deepEqual(f.calls, {queries: 0, connects: 0, scheduled: 0, material: 0, feeds: 0});
 });
}

test('fence requires the exact protective-automation warning acknowledgment', async () => {
 const f = await closedFixture();
 for (const value of [undefined, null, true, 'I agree']) {
  const b: Row = {...(await input()).fence, protectiveAutomationAcknowledgment: value};
  if (value === undefined) delete b.protectiveAutomationAcknowledgment;
  assert.equal((await f.service.fence(owner, b)).ok, false);
 }
 assert.equal(f.calls.queries, 0);
});

test('reconcile requires a server receipt UUID, not client evidence', async () => {
 const f = await closedFixture();
 for (const value of [undefined, null, [], {}, true, 'forged-receipt']) {
  assert.equal((await f.service.reconcile(owner, {...(await input()).reconcile, fenceReceiptId: value})).ok, false);
 }
 assert.deepEqual(f.calls, {queries: 0, connects: 0, scheduled: 0, material: 0, feeds: 0});
});

test('missing server dependencies fail closed without using any supplied capability', async () => {
 const [{createOwnerUnknownRecoveryService}] = await imports;
 for (const missing of ['db', 'now', 'isScheduled', 'material', 'readFeeds']) {
  const f = await closedFixture();
  const deps = {...f.deps, [missing]: undefined};
  const result = await createOwnerUnknownRecoveryService(deps as never).reconcile(owner, (await input()).reconcile);
  assert.equal(result.ok, false, missing);
  assert.equal(result.reason, 'recovery_dependencies_unavailable');
  assert.deepEqual(f.calls, {queries: 0, connects: 0, scheduled: 0, material: 0, feeds: 0});
 }
 for (const deps of [undefined, {}, {db: {}}, {db: {connect: async () => null}}]) {
  const result = await createOwnerUnknownRecoveryService(deps as never).fence(owner, (await input()).fence);
  assert.equal(result.ok, false);
 }
});

async function fenceFixture(mode: 'ok' | 'foreign' | 'ambiguous' | 'unknown-commit' | 'audit-failure' | 'target-foreign' = 'ok') {
 const [{createOwnerUnknownRecoveryService}] = await imports;
 const calls: {sql: string; args: unknown[]}[] = [];
 let connects = 0, signers = 0, feeds = 0, discard = false;
 const client = {query: async (sql: string, args: unknown[] = []) => {
  calls.push({sql, args});
  if (sql.startsWith('SELECT id,owner_user_id')) return {rows: [{id: accountId, owner_user_id: owner,
   revision: '7', key_fingerprint: 'a'.repeat(64), subaccount: 1, exchange_index: 2}]};
  if (sql.startsWith('SELECT execution_account_id')) return {rows: [{execution_account_id: accountId,
   owner_user_id: owner, state: 'owned', fencing_token: '7', credential_fingerprint: 'a'.repeat(64)}]};
  if (sql.startsWith('SELECT id,account_id,kind')) return {rows: mode === 'target-foreign' ? [] : [{id: target,
   account_id: accountId, kind: 'ENTRY', state: 'UNKNOWN', terminal: false, reserved_micros: '6000000'}]};
  if (sql.startsWith('UPDATE public.v13_production_account')) return {rows: [{revision: '8'}]};
  if (sql.startsWith('UPDATE private.kalshi_account_worker_lease')) return {rows: [{fencing_token: '8'}]};
  if (sql.startsWith('INSERT') && mode === 'audit-failure') throw Error('synthetic_audit_failure');
  if (sql === 'COMMIT' && mode === 'unknown-commit') throw Error('synthetic_ack_lost');
  return {rows: []};
 }, release: (error?: Error) => {discard = !!error;}};
 const db = {query: async (sql: string, args: unknown[] = []) => {
  calls.push({sql, args});
  assert.match(sql, /owner_user_id=\$1::uuid AND subaccount=1 AND exchange_index=2/);
  assert.deepEqual(args, [owner]);
  return {rows: mode === 'foreign' ? [] : mode === 'ambiguous' ? [{id: accountId}, {id: 'other'}] : [{id: accountId}]};
 }, connect: async () => {connects++; return client;}};
 const service = createOwnerUnknownRecoveryService({db, now: () => now, isScheduled: () => false,
  material: async () => {signers++; throw Error('unexpected_signer');},
  readFeeds: async () => {feeds++; throw Error('unexpected_provider');}} as never);
 return {service, calls, counts: () => ({connects, signers, feeds, discard})};
}

test('fence only derives the authenticated owner account and exact target with no signer or order capability', async () => {
 const f = await fenceFixture();
 const r = await f.service.fence(owner, (await input()).fence);
 assert.equal(r.ok, true);
 assert.equal(r.accountingCommitted, false);
 assert.equal(r.tradingAuthorized, false);
 assert.deepEqual(f.counts(), {connects: 1, signers: 0, feeds: 0, discard: false});
 assert.equal(f.calls.filter(c => c.sql === 'COMMIT').length, 1);
 assert.equal(f.calls.filter(c => /^(UPDATE|INSERT)/.test(c.sql)).length, 3);
 const intent = f.calls.find(c => c.sql.startsWith('SELECT id,account_id,kind'))!;
 assert.deepEqual(intent.args, [target, accountId]);
});

for (const mode of ['foreign', 'ambiguous', 'target-foreign'] as const) test(`fence ${mode} is refused without writes`, async () => {
 const f = await fenceFixture(mode);
 assert.equal((await f.service.fence(owner, (await input()).fence)).ok, false);
 assert.equal(f.calls.some(c => /^(UPDATE|INSERT|COMMIT)/.test(c.sql)), false);
 assert.equal(f.counts().signers, 0);
 assert.equal(f.counts().feeds, 0);
});

test('lost fence COMMIT acknowledgment is uncertain, discards the connection, and is never replayed', async () => {
 const f = await fenceFixture('unknown-commit');
 const r = await f.service.fence(owner, (await input()).fence);
 assert.equal(r.ok, false);
 assert.equal('outcomeUnknown' in r && r.outcomeUnknown, true);
 assert.equal('attemptId' in r && typeof r.attemptId, 'string');
 assert.equal(r.reason, 'recovery_fence_commit_outcome_unverified');
 assert.equal(f.calls.filter(c => c.sql === 'COMMIT').length, 1);
 assert.equal(f.calls.filter(c => c.sql.startsWith('INSERT')).length, 1);
 assert.deepEqual(f.counts(), {connects: 1, signers: 0, feeds: 0, discard: true});
});

test('fence audit failure rolls back and does not attempt COMMIT', async () => {
 const f = await fenceFixture('audit-failure');
 const r = await f.service.fence(owner, (await input()).fence);
 assert.equal(r.ok, false);
 assert.equal('outcomeUnknown' in r && r.outcomeUnknown, false);
 assert.equal(f.calls.some(c => c.sql === 'COMMIT'), false);
 assert.equal(f.calls.filter(c => c.sql === 'ROLLBACK').length, 1);
});

async function receiptFixture(kind: 'fence' | 'accounting' = 'accounting') {
 const [{createOwnerUnknownRecoveryService}, {ownerUnknownEvidenceDigest: hash}] = await imports;
 const payload: Row = {ownerId: owner, accountId, targetIntentId: target, tradingAuthorized: false,
  ...(kind === 'fence' ? {priorToken: '7', nextToken: '8', priorRevision: '7', nextRevision: '8', financialStateChanged: false}
   : {killReceiptId: receiptId, priorRevision: '8', fencingToken: '8', holdDigest: 'a'.repeat(64),
    historyDigest: 'b'.repeat(64), snapshotDigest: 'c'.repeat(64), observedAtMs: now - 1000, riskFreezeCleared: false})};
 const row: Row = {id: receiptId, account_id: accountId,
  kind: kind === 'fence' ? 'OWNER_UNKNOWN_ACCOUNTING_KILL_FENCE' : 'OWNER_UNKNOWN_ACCOUNTING_RECONCILIATION',
  payload, digest: hash(payload), observed_at: new Date(now), owner_user_id: owner,
  revision: kind === 'fence' ? '8' : '9', reserved_micros: kind === 'fence' ? '6000000' : '0',
  kill_switch: true, execution_enabled: false, lease_state: 'killed', account_kill: true,
  arm_requested: false, fencing_token: '8', target_intent_id: target,
  intent_state: kind === 'fence' ? 'UNKNOWN' : 'TERMINAL', intent_terminal: kind !== 'fence',
  intent_reserved_micros: kind === 'fence' ? '6000000' : '0', local_positions_flat: true,
  local_history_terminal: kind !== 'fence'};
 let rows: Row[] = [row], scheduled = false, queries = 0;
 const service = createOwnerUnknownRecoveryService({db: {query: async (sql: string, args: unknown[]) => {
  queries++;
  assert.match(sql, /a\.owner_user_id=\$1::uuid/);
  assert.match(sql, /o\.id=\$2/);
  assert.deepEqual(args, [owner, receiptId]);
  return {rows};
 }, connect: async () => {throw Error('receipt_must_not_start_transaction');}}, now: () => now,
 isScheduled: () => scheduled, material: async () => {throw Error('receipt_must_not_load_signer');},
 readFeeds: async () => {throw Error('receipt_must_not_read_provider');}} as never);
 return {service, row, payload, hash, setRows: (r: Row[]) => {rows = r;}, setScheduled: () => {scheduled = true;},
  queries: () => queries};
}

test('committed accounting receipt reports exact owner, retained kill, terminal flatness and no retry authority', async () => {
 const f = await receiptFixture();
 const r = await f.service.receipt(owner, receiptId) as Row;
 assert.equal(r.ok, true);
 assert.equal(r.receiptCommitted, true);
 assert.equal(r.accountingCommitted, true);
 assert.equal(r.currentStateMatchesReceipt, true);
 assert.equal(r.executionRemainsKilled, true);
 assert.equal(r.localAccountingTerminalAndFlat, true);
 assert.equal(r.retryAuthorized, false);
 assert.equal(r.tradingAuthorized, false);
 assert.equal(r.ordersSubmitted, false);
 assert.equal(r.workerStarted, false);
 assert.equal(f.queries(), 1);
 assert.equal('payload' in r, false);
 assert.equal('digest' in r, false);
});

test('fence receipt can confirm safety fencing while reserved UNKNOWN accounting remains held', async () => {
 const f = await receiptFixture('fence');
 const r = await f.service.receipt(owner, receiptId) as Row;
 assert.equal(r.ok, true);
 assert.equal(r.accountingCommitted, false);
 assert.equal(r.currentStateMatchesReceipt, true);
 assert.equal(r.executionRemainsKilled, true);
 assert.equal(r.localAccountingTerminalAndFlat, false);
 assert.equal(r.retryAuthorized, false);
});

for (const missing of [true, false]) test(`receipt ${missing ? 'missing or foreign-owner' : 'ambiguous'} never proves rollback or authorizes retry`, async () => {
 const f = await receiptFixture();
 f.setRows(missing ? [] : [f.row, f.row]);
 const r = await f.service.receipt(owner, receiptId) as Row;
 assert.equal(r.ok, false);
 assert.equal(r.outcomeUnknown, true);
 assert.equal(r.accountingCommitted, null);
 assert.equal(r.retryAuthorized, false);
});

for (const field of ['ownerId', 'accountId', 'targetIntentId', 'tradingAuthorized', 'digest'] as const) {
 test(`receipt refuses tampered ${field}`, async () => {
  const f = await receiptFixture();
  if (field === 'digest') f.row.digest = '0'.repeat(64);
  else {f.payload[field] = field === 'tradingAuthorized' ? true : other; f.row.digest = f.hash(f.payload);}
  const r = await f.service.receipt(owner, receiptId) as Row;
  assert.equal(r.ok, false);
  assert.equal(r.outcomeUnknown, true);
  assert.equal(r.retryAuthorized, false);
 });
}

for (const field of ['revision', 'fencing_token', 'kill_switch', 'execution_enabled', 'lease_state',
 'account_kill', 'arm_requested', 'intent_terminal', 'intent_reserved_micros', 'reserved_micros',
 'local_positions_flat', 'local_history_terminal', 'scheduled'] as const) {
 test(`receipt fails closed on changed current ${field}`, async () => {
  const f = await receiptFixture();
  if (field === 'scheduled') f.setScheduled();
  else {
   const change: Row = {revision: '10', fencing_token: '9', kill_switch: false, execution_enabled: true,
    lease_state: 'owned', account_kill: false, arm_requested: true, intent_terminal: false,
    intent_reserved_micros: '1', reserved_micros: '1', local_positions_flat: false, local_history_terminal: false};
   f.row[field] = change[field];
  }
  const r = await f.service.receipt(owner, receiptId) as Row;
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.receiptCommitted, true);
  assert.equal(r.accountingCommitted, true);
  assert.equal(r.outcomeUnknown, false);
  assert.equal(r.retryAuthorized, false);
  assert.equal(r.tradingAuthorized, false);
 });
}

for (const [kind, field, value] of [
 ['fence', 'financialStateChanged', true], ['fence', 'priorToken', '8'], ['fence', 'priorRevision', '8'],
 ['accounting', 'riskFreezeCleared', true], ['accounting', 'priorRevision', 'invalid'],
 ['accounting', 'killReceiptId', 'not-a-uuid'], ['accounting', 'snapshotDigest', 'not-a-digest'],
] as const) test(`${kind} receipt rejects invalid ${field} even when digest matches stored payload`, async () => {
 const f = await receiptFixture(kind);
 f.payload[field] = value;
 f.row.digest = f.hash(f.payload);
 const r = await f.service.receipt(owner, receiptId) as Row;
 assert.equal(r.ok, false, JSON.stringify(r));
 assert.equal(r.retryAuthorized, false);
});

test('receipt validates identity and ID before database access', async () => {
 const f = await closedFixture();
 assert.equal((await f.service.receipt('invalid-owner', receiptId)).ok, false);
 assert.equal((await f.service.receipt(owner, 'invalid-receipt')).ok, false);
 assert.equal(f.calls.queries, 0);
});

test('receipt database failures expose no error details and authorize no retry', async () => {
 const f = await closedFixture();
 const r = await f.service.receipt(owner, receiptId) as Row;
 assert.equal(r.ok, false);
 assert.equal(r.outcomeUnknown, true);
 assert.equal(r.retryAuthorized, false);
 assert.equal(JSON.stringify(r).includes('unexpected_database_query'), false);
});


for (const field of ['id', 'owner_user_id', 'target_intent_id'] as const) test(`receipt rejects mismatched persisted ${field}`, async () => {
 const f = await receiptFixture();
 f.row[field] = other;
 const r = await f.service.receipt(owner, receiptId) as Row;
 assert.equal(r.ok, false);
 assert.equal(r.accountingCommitted, null);
 assert.equal(r.outcomeUnknown, true);
 assert.equal(r.retryAuthorized, false);
});

test('committed fence receipt does not stay usable after target accounting changes', async () => {
 const f = await receiptFixture('fence');
 f.row.intent_state = 'TERMINAL';
 f.row.intent_terminal = true;
 f.row.intent_reserved_micros = '0';
 const r = await f.service.receipt(owner, receiptId) as Row;
 assert.equal(r.ok, false);
 assert.equal(r.receiptCommitted, true);
 assert.equal(r.accountingCommitted, false);
 assert.equal(r.outcomeUnknown, false);
 assert.equal(r.retryAuthorized, false);
});
