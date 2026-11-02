import {createHash} from "node:crypto";

/** Public, immutable transport provenance. This is never fee/entry authority. */
export type MetadataBodyCapture = Readonly<{
  path: string;
  requestStartedAtMs: number;
  capturedAtMs: number;
  rawSha256: string;
  /** SHA256(JSON.stringify(parsedBody)); distinct from the raw byte digest. */
  normalizedSha256: string;
}>;
export type MetadataCaptureManifest = Readonly<{
  marketTicker: string;
  eventTicker: string;
  exchangeIndex: 2;
  records: readonly MetadataBodyCapture[];
}>;
export type ValidatedMetadataCapture = Readonly<{
  manifest: MetadataCaptureManifest;
  /** Conservative age begins when the oldest public request actually began. */
  observedAtMs: number;
  capturedThroughMs: number;
  fingerprint: string;
}>;
const ticker = /^KXBTC15M-[A-Za-z0-9-]+$/;
const sha256 = (value:string) => createHash("sha256").update(value).digest("hex");
const hex = /^[a-f0-9]{64}$/;
const timestamp = (value:unknown):value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Does not read a clock, contact a provider, renew observation time or mutate
 * semantic fee/model identity. The caller supplies its existing sampled time.
 * Exactly five bodies must match their original normalized digests. Raw digests
 * are retained (they cannot be reconstructed from JSON-normalized bodies).
 */
export function validateMetadataCapture(input: {
  manifest: MetadataCaptureManifest;
  marketTicker: string;
  eventTicker: string;
  nowMs: number;
  marketPayload: unknown;
  eventPayload: unknown;
  seriesPayload: unknown;
  seriesChangesPayload: unknown;
  eventChangesPayload: unknown;
}): ValidatedMetadataCapture | null {
  try {
    const {manifest,marketTicker,eventTicker,nowMs}=input;
    if (!ticker.test(marketTicker) || !ticker.test(eventTicker) || !timestamp(nowMs) ||
        !manifest || manifest.marketTicker!==marketTicker || manifest.eventTicker!==eventTicker ||
        manifest.exchangeIndex!==2 || !Array.isArray(manifest.records) || manifest.records.length!==5)
      return null;
    const expected:readonly (readonly [string,unknown])[]=[
      [`/markets/${encodeURIComponent(marketTicker)}`,input.marketPayload],
      ["/series/KXBTC15M",input.seriesPayload],
      ["/series/fee_changes?series_ticker=KXBTC15M&show_historical=false",input.seriesChangesPayload],
      [`/events/${encodeURIComponent(eventTicker)}`,input.eventPayload],
      [`/events/fee_changes?event_ticker=${encodeURIComponent(eventTicker)}&limit=100`,input.eventChangesPayload],
    ];
    const records:MetadataBodyCapture[]=[];
    for (const [path,payload] of expected) {
      const matches=manifest.records.filter(record=>record && record.path===path);
      if(matches.length!==1)return null;
      const record=matches[0]!;
      if(!timestamp(record.requestStartedAtMs)||!timestamp(record.capturedAtMs)||
          record.requestStartedAtMs>record.capturedAtMs || record.capturedAtMs>nowMs ||
          nowMs-record.requestStartedAtMs>15_000 || typeof record.rawSha256!=="string" ||
          typeof record.normalizedSha256!=="string" || !hex.test(record.rawSha256) || !hex.test(record.normalizedSha256) || record.normalizedSha256!==sha256(JSON.stringify(payload)))
        return null;
      records.push(Object.freeze({path,requestStartedAtMs:record.requestStartedAtMs,
        capturedAtMs:record.capturedAtMs,rawSha256:record.rawSha256,
        normalizedSha256:record.normalizedSha256}));
    }
    // Event identity is unlocked only by the completed exact-market response.
    if(records[3]!.requestStartedAtMs<records[0]!.capturedAtMs ||
        records[4]!.requestStartedAtMs<records[0]!.capturedAtMs)return null;
    const captured=Object.freeze({marketTicker,eventTicker,exchangeIndex:2 as const,
      records:Object.freeze(records)});
    return Object.freeze({manifest:captured,
      observedAtMs:Math.min(...records.map(record=>record.requestStartedAtMs)),
      capturedThroughMs:Math.max(...records.map(record=>record.capturedAtMs)),
      fingerprint:sha256(JSON.stringify({scope:"public_metadata_capture_v1",...captured})),
    });
  } catch {return null;}
}
