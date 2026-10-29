/** The shared Supabase session pool is smaller than the PostgreSQL max_connections.
 * Keep existing size by default; operations may lower it during pool exhaustion.
 * Invalid values fail to the previously deployed default, never to unbounded growth.
 */
export function configuredPoolMax(raw: string | undefined): number {
  if (raw === undefined) return 10;
  if (!/^[0-9]+$/.test(raw)) return 10;
  const value=Number(raw);
  return Number.isSafeInteger(value) && value>=2 && value<=10 ? value : 10;
}
