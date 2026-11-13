import test from 'node:test';
import assert from 'node:assert/strict';
import {pool, type Pool, type PoolClient} from '@workspace/db';
import {SESSION_RELATIONS} from './apiFeeRuntimeDbSession';
import {backendRole, installFullRecoverySchema} from './ownerUnknownRecoverySchema.fixture';

// DISPOSABLE TEST ONLY. These roles/policies are behavioral probes, NOT a
// production grant manifest, approved migration, or verified authentication.
// The unchanged canonical runner strips credentials and fences external I/O.
const url = process.env.V13_DISPOSABLE_DATABASE_URL;
assert.ok(url && url === process.env.DATABASE_URL &&
  /^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url),
  'only the canonical freshly-created disposable PostgreSQL destination is allowed');

const roles = {api: 'fixture_role_api', worker: 'fixture_role_worker', unrelated: 'fixture_role_unrelated'} as const;
const owners = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
  c: '33333333-3333-4333-8333-333333333333',
} as const;
const account = {a: 'role-matrix-owner-a', b: 'role-matrix-owner-b', transient: 'role-matrix-rollback'};
const contextKey = 'strata_role_matrix.owner_id';
const authorityRelations = new Set<string>([
  'private.strata_protective_exit_release', 'private.strata_owner_sha_approvals',
]);
const NativePool = pool.constructor as new (config: {
  connectionString: string; options?: string; max: number; connectionTimeoutMillis: number;
}) => Pool;
const runtimePools: Pool[] = [];

function runtimePool(role: string, max = 1): Pool {
  // Actual LOGIN roles: a superuser connection followed by SET ROLE would not
  // prove that RESET ROLE or role membership cannot regain bootstrap powers.
  const target = new URL(url!);
  target.username = role;
  const db = new NativePool({connectionString: target.toString(), max, connectionTimeoutMillis: 3000});
  runtimePools.push(db);
  return db;
}

const insertAccount = `INSERT INTO public.v13_production_account
  (id,owner_user_id,subaccount,exchange_index,key_fingerprint,cash_micros,initial_cash_micros)
  VALUES($1,$2::uuid,1,2,$3,0,0) RETURNING id`;
const insertArgs = (id: string, owner: string) => [id, owner, 'a'.repeat(64)];
const visible = async (db: Pick<Pool, 'query'> | PoolClient) =>
  (await db.query('SELECT id FROM public.v13_production_account ORDER BY id')).rows.map(row => row.id);

async function context(client: PoolClient, owner: string): Promise<void> {
  await client.query('SELECT set_config($1,$2,true)', [contextKey, owner]);
}

async function rollbackAndRelease(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); }
  catch (error) { client.release(true); throw error; }
  client.release();
}

async function cleanupClients(clients: PoolClient[], original?: {error: unknown}): Promise<void> {
  const results = await Promise.allSettled(clients.map(rollbackAndRelease));
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length) throw new AggregateError(original ? [original.error, ...failures] : failures,
    'disposable client cleanup failed; original test failure, if any, is preserved first');
}

async function rolledBack(db: Pool, run: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await db.connect();
  let original: {error: unknown} | undefined;
  try {
    await client.query('BEGIN');
    await run(client);
  } catch (error) {
    original = {error};
    throw error;
  } finally {
    await cleanupClients([client], original);
  }
}

test('disposable non-owner role matrix: capability reduction is not tenant authentication', async t => {
  const owner = new NativePool({connectionString: url, options: `-c role=${backendRole}`,
    max: 1, connectionTimeoutMillis: 3000});
  try {
    // installFullRecoverySchema verifies database/user/loopback/port on the
    // connection BEFORE DDL and applies the complete source migration manifest.
    const bootstrap = await pool.connect();
    try {
      await installFullRecoverySchema(bootstrap);
      for (const role of Object.values(roles)) {
        await bootstrap.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER
          NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
        await bootstrap.query(`GRANT USAGE ON SCHEMA public,private TO ${role}`);
        await bootstrap.query(`GRANT SELECT,INSERT,UPDATE ON ${SESSION_RELATIONS.join(',')} TO ${role}`);
      }
    } finally { bootstrap.release(); }

    await owner.query('INSERT INTO auth.users(id) VALUES($1),($2),($3)', Object.values(owners));
    await owner.query(insertAccount, insertArgs(account.a, owners.a));
    await owner.query(insertAccount, insertArgs(account.b, owners.b));
    const api = runtimePool(roles.api), worker = runtimePool(roles.worker), unrelated = runtimePool(roles.unrelated);

    await t.test('existing NOBYPASSRLS owner sees rows despite zero policies and FORCE=false', async () => {
      const identity = (await owner.query(`SELECT current_user AS role,rolsuper,rolbypassrls
        FROM pg_catalog.pg_roles WHERE rolname=current_user`)).rows[0];
      assert.deepEqual(identity, {role: backendRole, rolsuper: false, rolbypassrls: false});
      assert.deepEqual(await visible(owner), [account.a, account.b]);
      for (const relation of SESSION_RELATIONS) {
        const state = (await owner.query(`SELECT pg_get_userbyid(c.relowner) AS owner,
          c.relrowsecurity,c.relforcerowsecurity,
          (SELECT count(*)::int FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid) AS policies
          FROM pg_catalog.pg_class c WHERE c.oid=$1::regclass`, [relation])).rows[0];
        assert.deepEqual(state, {owner: backendRole, relrowsecurity: true, relforcerowsecurity: false, policies: 0}, relation);
      }
    });

    await t.test('actual runtime logins have no elevated attributes, ownership or role memberships', async () => {
      for (const [role, db] of [[roles.api, api], [roles.worker, worker], [roles.unrelated, unrelated]] as const) {
        const actual = (await db.query(`SELECT current_user AS current_role,session_user AS session_role,
          rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
          FROM pg_catalog.pg_roles WHERE rolname=current_user`)).rows[0];
        assert.deepEqual(actual, {current_role: role, session_role: role, rolsuper: false,
          rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false});
        assert.equal((await db.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_auth_members
          WHERE member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)`)).rows[0].n, 0);
        assert.equal((await db.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_class
          WHERE relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)`)).rows[0].n, 0);
        await assert.rejects(db.query(`SET ROLE ${backendRole}`), {code: '42501'});
        await assert.rejects(db.query('SET ROLE v13_test'), {code: '42501'});
        await db.query('RESET ROLE');
        assert.equal((await db.query('SELECT current_user AS role')).rows[0].role, role);
      }
    });

    await t.test('non-owner ACLs do not bypass zero-policy RLS: reads/updates hide rows and inserts fail', async () => {
      for (const db of [api, worker, unrelated]) {
        for (const relation of SESSION_RELATIONS) {
          for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
            assert.equal((await db.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed',
              [relation, privilege])).rows[0].allowed, true, `${relation} ${privilege}`);
          }
          assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${relation}`)).rows[0].n, 0, relation);
        }
        assert.equal((await db.query('UPDATE public.v13_production_account SET revision=revision+1 RETURNING id')).rowCount, 0);
        await assert.rejects(db.query(insertAccount, insertArgs(account.transient, owners.c)), {code: '42501'});
      }
      assert.deepEqual(await visible(owner), [account.a, account.b]);
    });

    await t.test('runtime cannot create roles/databases/replication slots or change the safety schema', async () => {
      for (const db of [api, worker, unrelated]) {
        await assert.rejects(db.query('CREATE ROLE fixture_forbidden_role NOLOGIN'), {code: '42501'});
        await assert.rejects(db.query('CREATE DATABASE fixture_forbidden_database'), {code: '42501'});
        // Physical slot creation checks the replication privilege before WAL
        // requirements, and never connects to any external system.
        await assert.rejects(db.query("SELECT * FROM pg_catalog.pg_create_physical_replication_slot('fixture_forbidden_slot')"), {code: '42501'});
        await assert.rejects(db.query('CREATE TABLE public.fixture_forbidden_table(id integer)'), {code: '42501'});
        await assert.rejects(db.query('ALTER TABLE public.v13_production_account DISABLE TRIGGER ALL'), {code: '42501'});
        await assert.rejects(db.query('TRUNCATE public.v13_production_account'), {code: '42501'});
        await assert.rejects(db.query('DELETE FROM public.v13_production_account'), {code: '42501'});
        await assert.rejects(db.query('SELECT * FROM private.kalshi_connection_credentials'), {code: '42501'});
        await assert.rejects(db.query('SELECT * FROM vault.secrets'), {code: '42501'});
      }
    });

    await t.test('source SECURITY DEFINER functions retain fixture ownership, explicit paths and bounded EXECUTE ACLs', async () => {
      // This fixture creates service_role fresh, without upstream memberships or
      // earlier grants. Production may legitimately have additional EXECUTE on
      // can_inspect: migration 0022 does not revoke service_role explicitly.
      assert.equal((await owner.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_auth_members
        WHERE member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='service_role')`)).rows[0].n, 0);
      const functions = [
        {signature: 'public.strata_claim_official_fee_capture()', path: 'public,pg_temp', allowed: ['service_role']},
        {signature: 'public.strata_can_inspect_pending_fee_artifact()', path: 'pg_catalog,pg_temp', allowed: ['authenticated']},
        {signature: 'public.strata_two_operator_fee_reviews_valid(uuid,uuid,text)', path: 'pg_catalog,pg_temp', allowed: ['service_role']},
        {signature: 'public.strata_record_official_fee_provider_result(integer,timestamptz)', path: 'public,pg_temp', allowed: ['service_role']},
        ...['strata_v13_begin_trace_scope', 'strata_v13_capture_intent',
          'strata_v13_capture_event', 'strata_v13_capture_transport'].map(name =>
          ({signature: `private.${name}()`, path: '', allowed: [] as string[]})),
      ];
      const observed = (await owner.query(`SELECT p.oid FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE p.prosecdef AND n.nspname IN ('public','private')`)).rows;
      assert.equal(observed.length, functions.length, 'new definers require an explicit review entry');
      for (const entry of functions) {
        const fn = (await owner.query(`SELECT p.oid,pg_get_userbyid(p.proowner) AS owner,
          p.prosecdef,p.proconfig,
          EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
            WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
          FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure($1)`, [entry.signature])).rows[0];
        assert.ok(fn, entry.signature);
        assert.equal(fn.owner, backendRole, entry.signature);
        assert.equal(fn.prosecdef, true, entry.signature);
        assert.equal(fn.public_execute, false, entry.signature);
        const paths = (fn.proconfig as string[]).filter(setting => setting.startsWith('search_path='));
        assert.equal(paths.length, 1, entry.signature);
        assert.equal(paths[0]!.slice('search_path='.length).replace(/[\s"]/g, ''), entry.path, entry.signature);
        for (const role of ['anon', 'authenticated', 'service_role', ...Object.values(roles)]) {
          assert.equal((await owner.query('SELECT has_function_privilege($1,$2::oid,\'EXECUTE\') AS allowed',
            [role, fn.oid])).rows[0].allowed, entry.allowed.includes(role), `${entry.signature} ${role}`);
        }
      }
      // These are actual denied calls, not execution of a fee mutation function.
      for (const db of [api, worker, unrelated]) {
        await assert.rejects(db.query('SELECT public.strata_can_inspect_pending_fee_artifact()'), {code: '42501'});
        await assert.rejects(db.query('SELECT public.strata_claim_official_fee_capture()'), {code: '42501'});
      }
    });

    // Only the fixture owner can install these temporary demonstration policies.
    // They deliberately do NOT describe a complete protective-worker grant set.
    for (const relation of SESSION_RELATIONS) {
      await owner.query(`CREATE POLICY fixture_worker_select ON ${relation}
        FOR SELECT TO ${roles.worker} USING(true)`);
      if (authorityRelations.has(relation)) continue;
      await owner.query(`CREATE POLICY fixture_worker_insert ON ${relation}
        FOR INSERT TO ${roles.worker} WITH CHECK(true)`);
      await owner.query(`CREATE POLICY fixture_worker_update ON ${relation}
        FOR UPDATE TO ${roles.worker} USING(true) WITH CHECK(true)`);
    }
    // The real account-insert trigger writes this scope row as a definer. Read
    // access below lets the test prove it existed before transaction rollback.
    await owner.query(`GRANT SELECT ON private.strata_v13_signal_trace_scope TO ${roles.worker}`);
    await owner.query(`CREATE POLICY fixture_worker_scope_select ON private.strata_v13_signal_trace_scope
      FOR SELECT TO ${roles.worker} USING(true)`);
    const predicate = `owner_user_id=NULLIF(current_setting('${contextKey}',true),'')::uuid`;
    await owner.query(`CREATE POLICY fixture_api_select ON public.v13_production_account
      FOR SELECT TO ${roles.api} USING(${predicate})`);
    await owner.query(`CREATE POLICY fixture_api_insert ON public.v13_production_account
      FOR INSERT TO ${roles.api} WITH CHECK(${predicate})`);
    await owner.query(`CREATE POLICY fixture_api_update ON public.v13_production_account
      FOR UPDATE TO ${roles.api} USING(${predicate}) WITH CHECK(${predicate})`);

    await t.test('explicit worker policies restore service-wide rows, unrelated ACL-bearing role stays denied', async () => {
      assert.deepEqual(await visible(worker), [account.a, account.b]);
      assert.deepEqual(await visible(unrelated), []);
      assert.equal((await unrelated.query('UPDATE public.v13_production_account SET revision=revision+1')).rowCount, 0);
      await assert.rejects(unrelated.query(insertAccount, insertArgs(account.transient, owners.c)), {code: '42501'});
      await assert.rejects(worker.query('DELETE FROM public.v13_production_account'), {code: '42501'});
    });

    await t.test('worker policies cannot create human release authority even with an INSERT ACL', async () => {
      await assert.rejects(worker.query(`INSERT INTO private.strata_protective_exit_release
        (release_commit_sha,independent_reviewer_id,operator_approver_id,review_url,release_evidence_digest,expires_at)
        VALUES($1,$2,$3,'https://github.com/PatentFiles/Strata-Backend/pull/0',$4,now()+interval '1 hour')`,
      ['f'.repeat(40), owners.a, owners.b, 'b'.repeat(64)]), {code: '42501'});
      for (const relation of authorityRelations) {
        assert.equal((await owner.query(`SELECT count(*)::int AS n FROM ${relation}`)).rows[0].n, 0);
        const policies = (await owner.query(`SELECT polcmd FROM pg_catalog.pg_policy
          WHERE polrelid=$1::regclass ORDER BY polcmd`, [relation])).rows;
        assert.deepEqual(policies, [{polcmd: 'r'}]);
      }
    });

    await t.test('worker insert and real definer-trigger row both roll back; no approval or execution is enabled', async () => {
      await rolledBack(worker, async client => {
        assert.equal((await client.query(insertAccount, insertArgs(account.transient, owners.c))).rowCount, 1);
        assert.equal((await client.query(`SELECT count(*)::int AS n FROM private.strata_v13_signal_trace_scope
          WHERE execution_account_id=$1`, [account.transient])).rows[0].n, 1);
        assert.equal((await client.query(`UPDATE public.v13_production_account SET revision=revision+1
          WHERE id=$1 RETURNING id`, [account.a])).rowCount, 1);
      });
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM public.v13_production_account WHERE id=$1',
        [account.transient])).rows[0].n, 0);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM private.strata_v13_signal_trace_scope WHERE execution_account_id=$1',
        [account.transient])).rows[0].n, 0);
      assert.deepEqual((await owner.query(`SELECT revision::text AS revision,kill_switch,execution_enabled,commissioned
        FROM public.v13_production_account WHERE id=$1`, [account.a])).rows[0],
      {revision: '0', kill_switch: true, execution_enabled: false, commissioned: false});
    });

    await t.test('SET LOCAL context is required and resets on COMMIT, ROLLBACK and aborted pooled transactions', async () => {
      assert.deepEqual(await visible(api), []);
      let firstPid: number | undefined;
      for (const finish of ['COMMIT', 'ROLLBACK'] as const) {
        const client = await api.connect();
        let original: {error: unknown} | undefined;
        try {
          const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
          firstPid ??= pid;
          assert.equal(pid, firstPid, 'max=1 must reuse the same physical session');
          assert.equal((await client.query('SELECT NULLIF(current_setting($1,true),\'\') AS value', [contextKey])).rows[0].value, null);
          await client.query('BEGIN');
          await context(client, finish === 'COMMIT' ? owners.a : owners.b);
          assert.deepEqual(await visible(client), [finish === 'COMMIT' ? account.a : account.b]);
          assert.equal((await client.query('UPDATE public.v13_production_account SET revision=revision+1 WHERE id=$1',
            [finish === 'COMMIT' ? account.b : account.a])).rowCount, 0);
          await client.query(finish);
        } catch (error) {
          original = {error};
          throw error;
        } finally {
          await cleanupClients([client], original);
        }
        assert.deepEqual(await visible(api), [], `${finish} must clear context before pool reuse`);
      }
      await rolledBack(api, async client => {
        assert.equal((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, firstPid);
        await context(client, owners.a);
        assert.equal((await client.query('UPDATE public.v13_production_account SET revision=99 WHERE id=$1', [account.a])).rowCount, 1);
        await assert.rejects(client.query(insertAccount, insertArgs(account.transient, owners.c)), {code: '42501'});
        await assert.rejects(client.query('SELECT 1'), {code: '25P02'});
      });
      assert.deepEqual(await visible(api), []);
      assert.equal((await owner.query('SELECT revision::text AS revision FROM public.v13_production_account WHERE id=$1',
        [account.a])).rows[0].revision, '0');
      await rolledBack(api, async client => {
        await context(client, 'not-a-uuid');
        await assert.rejects(client.query('SELECT id FROM public.v13_production_account'), {code: '22P02'});
      });
      assert.deepEqual(await visible(api), []);
    });

    await t.test('custom context is NOT authentication: the database role can deliberately select either owner', async () => {
      for (const [who, id] of [[owners.a, account.a], [owners.b, account.b]] as const) {
        await rolledBack(api, async client => {
          await context(client, who);
          assert.deepEqual(await visible(client), [id]);
        });
      }
      // A production design still needs verified identity, trusted transaction
      // binding, and exhaustive injection; a writable custom GUC is not proof.
      assert.deepEqual(await visible(api), []);
    });

    await t.test('transaction-local operational settings restore the pooled session baseline on commit and abort', async () => {
      const settings = async (client: PoolClient) => (await client.query(`SELECT
        pg_backend_pid() AS pid,current_user AS role,session_user AS session_role,
        current_setting('search_path') AS search_path,current_setting('row_security') AS row_security,
        current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout`)).rows[0];
      const initial = await api.connect();
      let baseline: Record<string, unknown>;
      try { baseline = await settings(initial); }
      finally { initial.release(); }
      for (const finish of ['COMMIT', 'ROLLBACK', 'ABORT'] as const) {
        const client = await api.connect();
        let original: {error: unknown} | undefined;
        try {
          assert.deepEqual(await settings(client), baseline);
          await client.query('BEGIN');
          await client.query(`SELECT set_config('search_path','pg_catalog',true),
            set_config('lock_timeout','321ms',true),set_config('statement_timeout','4321ms',true),
            set_config('row_security','on',true)`);
          const local = await settings(client);
          assert.equal(local.pid, baseline.pid, 'one transaction must keep its backend');
          assert.equal(local.search_path, 'pg_catalog');
          assert.equal(local.lock_timeout, '321ms');
          assert.equal(local.statement_timeout, '4321ms');
          assert.equal(local.row_security, 'on');
          if (finish === 'ABORT') {
            await assert.rejects(client.query('SELECT 1/0'), {code: '22012'});
            await assert.rejects(client.query('SELECT 1'), {code: '25P02'});
            await client.query('ROLLBACK');
          } else await client.query(finish);
          assert.deepEqual(await settings(client), baseline);
        } catch (error) {
          original = {error};
          throw error;
        } finally { await cleanupClients([client], original); }
      }
      const reused = await api.connect();
      try { assert.deepEqual(await settings(reused), baseline); }
      finally { reused.release(); }
    });

    await t.test('a session-level setting survives pool release: SET LOCAL alone cannot sanitize a dirty baseline', async () => {
      // Counterexample in an independent disposable pool. Nothing in the
      // production pool is changed, and this connection is destroyed afterward.
      const dirtyPool = runtimePool(roles.api);
      let firstPid: number;
      const dirty = await dirtyPool.connect();
      try {
        firstPid = (await dirty.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
        await dirty.query('SELECT set_config($1,$2,false)', [contextKey, owners.a]);
        assert.deepEqual(await visible(dirty), [account.a]);
      } finally { dirty.release(); }
      const reused = await dirtyPool.connect();
      try {
        assert.equal((await reused.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, firstPid);
        assert.deepEqual(await visible(reused), [account.a], 'Pool.release does not RESET session settings');
        await reused.query('BEGIN');
        await context(reused, owners.b);
        assert.deepEqual(await visible(reused), [account.b]);
        await reused.query('COMMIT');
        assert.deepEqual(await visible(reused), [account.a], 'SET LOCAL restores the prior session value, not an empty value');
      } finally { reused.release(true); }
      const clean = await dirtyPool.connect();
      try {
        assert.deepEqual(await visible(clean), []);
        assert.equal((await clean.query('SELECT NULLIF(current_setting($1,true),\'\') AS value', [contextKey])).rows[0].value, null);
      } finally { clean.release(true); }
    });

    await t.test('simultaneous checked-out transactions cannot see each other\'s local owner context', async () => {
      const concurrent = runtimePool(roles.api, 2);
      const first = await concurrent.connect();
      let second: PoolClient | undefined;
      let original: {error: unknown} | undefined;
      try {
        second = await concurrent.connect();
        const pids = await Promise.all([first, second].map(async client =>
          (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
        assert.notEqual(pids[0], pids[1]);
        await Promise.all([first.query('BEGIN'), second.query('BEGIN')]);
        await Promise.all([context(first, owners.a), context(second, owners.b)]);
        assert.deepEqual(await Promise.all([visible(first), visible(second)]), [[account.a], [account.b]]);
        await Promise.all([first.query('COMMIT'), second.query('ROLLBACK')]);
        assert.deepEqual(await Promise.all([visible(first), visible(second)]), [[], []]);
      } catch (error) {
        original = {error};
        throw error;
      } finally {
        await cleanupClients([first, second]
          .filter((client): client is PoolClient => client !== undefined), original);
      }
    });
  } finally {
    await Promise.all([...runtimePools, owner, pool].map(db => db.end()));
  }
});
