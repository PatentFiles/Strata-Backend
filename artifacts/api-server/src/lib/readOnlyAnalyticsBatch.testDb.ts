// Offline-only alias: the exact repository module cannot import a real database.
export const forwardTestEngineTable = { id: "engine.id" };
export const forwardTestEvaluationTable = { name: "evaluations" };
export const forwardTestWindowTable = { name: "windows" };
export const forwardTestPositionTable = { name: "positions", status: "status", pnl: "pnl", engineId: "engineId" };
export type Job = { fields: Record<string, unknown>; table: object; where: unknown; thenCalls: number; resolve: (value: any) => void; reject: (error: unknown) => void; promise: Promise<any> };
export const controls = {
  jobs: [] as Job[],
  active: 0,
  maxActive: 0,
  synchronousFailure: null as null | { index: number; error: unknown },
  constructions: 0,
  reset() { this.jobs = []; this.active = 0; this.maxActive = 0; this.synchronousFailure = null; this.constructions = 0; },
};
export const db = {
  select(fields: Record<string, unknown>) {
    const index = controls.constructions++;
    if (controls.synchronousFailure?.index === index) throw controls.synchronousFailure.error;
    return { from(table: object) {
      let resolve!: (value: any) => void, reject!: (error: unknown) => void;
      const promise = new Promise<any>((ok, fail) => { resolve = ok; reject = fail; });
      const job: Job = { fields, table, where: undefined, thenCalls: 0, resolve, reject, promise };
      controls.jobs.push(job);
      const query = {
        where(condition: unknown) { job.where = condition; return query; },
        then(onValue: any, onError: any) {
          job.thenCalls++; controls.active++; controls.maxActive = Math.max(controls.maxActive, controls.active);
          return promise.then(value => { controls.active--; return value; }, error => { controls.active--; throw error; }).then(onValue, onError);
        },
      };
      return query;
    } };
  },
};
