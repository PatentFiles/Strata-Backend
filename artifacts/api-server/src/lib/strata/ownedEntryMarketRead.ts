import type {EntryPrepareMarketContext,MarketEvidence} from "../v13-production/types";
import type {MetadataPrefetchAttempt,MetadataPrefetchScope,PrefetchedPublicMetadata} from "./committedPublicMetadata";
import type {MetadataCaptureManifest} from "./metadataCapture";
import {createEntryMetadataSnapshot} from "./entryMetadataSnapshot";
import {gatherCompleteReadOnlyMarketEvidence} from "./gatherReadOnlyMarketEvidence";
import {ownedMarketEvidence} from "./personalExchangeRead";
import {attachMarketEvidenceReadTiming,getMarketEvidenceReadTiming} from "./marketEvidenceReadTiming";

type PublicReader=(path:string)=>Promise<Record<string,unknown>>;
/** The supervisor's actual market read, shared with its offline integration
 * fixture. Explicit prepare or separately scoped FINAL_MARKET phases may adopt
 * their own exact-source public bytes. EXIT and unscoped calls remain fresh.
 * FINAL_MARKET never adopts PREPARE or WIRE_FEE captures. Fee authority and signed-book
 * adapters still run once at their existing stage, never in the coordinator.
 */
export async function readOwnedEntryMarket(input:{
  market:string;side:"YES"|"NO";context?:EntryPrepareMarketContext;
  now:()=>number;apiSource:boolean;activeMetadata:MetadataPrefetchAttempt|null;
  metadataScope:()=>MetadataPrefetchScope;
  finalPublicMetadata?:()=>PrefetchedPublicMetadata|undefined;
  verifyFee:(clock:number,readMetadata:PublicReader|undefined,captureMetadata:(()=>MetadataCaptureManifest)|undefined)=>Promise<number>;
  readBook:()=>Promise<unknown>;readPublic:(path:string)=>Promise<unknown>;publicFetch?:typeof fetch;
  configuredStakeCents:number;policyVersion:string;sourceUrl:string;formulaVersion:string;artifactDigest:string;policyHash:string;
}):Promise<MarketEvidence>{
  const clock=input.now(),{market,side,context,activeMetadata}=input;
  const finalMetadata=input.apiSource&&!context?input.finalPublicMetadata?.():undefined;
  const speculative=finalMetadata??(input.apiSource&&context?.stage==="prepare"&&activeMetadata?.source.evaluationId===context.evaluationId
    ?activeMetadata.consume(input.metadataScope(),context):undefined);
  if(context&&activeMetadata&&!speculative)activeMetadata.discard("entry_metadata_source_changed");
  const metadataSnapshot=input.apiSource?(speculative??createEntryMetadataSnapshot(market,input.publicFetch)):undefined;
  let verifiedAtMs:number;
  const gathered=await gatherCompleteReadOnlyMarketEvidence({market,
    verifyFee:async()=>{verifiedAtMs=await input.verifyFee(clock,metadataSnapshot?.read,speculative?.capture);},
    readBook:input.readBook,readPublic:metadataSnapshot?.read??input.readPublic,
  });
  const {bookPayload,seriesPayload,marketPayload,eventPayload,seriesChangesPayload,eventChangesPayload}=gathered;
  return attachMarketEvidenceReadTiming(ownedMarketEvidence({
    market,side,bookPayload,seriesPayload,marketPayload,eventPayload,seriesChangesPayload,eventChangesPayload,
    observedAtMs:clock,nowMs:input.now(),configuredStakeCents:input.configuredStakeCents,
    policyVersion:input.policyVersion,sourceUrl:input.sourceUrl,formulaVersion:input.formulaVersion,
    artifactDigest:input.artifactDigest,policyHash:input.policyHash,verifiedAtMs:verifiedAtMs!,
    ...(speculative?{metadataCapture:speculative.capture()}:{}),
  }),getMarketEvidenceReadTiming(gathered));
}
