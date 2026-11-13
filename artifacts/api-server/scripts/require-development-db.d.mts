export function requireDevelopmentDatabase(client: {
  query(text: string): Promise<{ rows: unknown[] }>;
}): Promise<void>;
