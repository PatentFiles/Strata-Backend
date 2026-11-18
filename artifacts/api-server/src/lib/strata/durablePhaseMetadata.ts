import {durablePhaseMetadataClock,type PrefetchedPublicMetadata,type MetadataPhaseBinding} from './committedPublicMetadata';
// Opaque invocation-bound handle, not serializable authority. The factory is
// called only by the owning phase coordinator after exact source consumption.
export type DurablePhaseMetadata=Readonly<{kind:'DURABLE_PHASE_PUBLIC_BYTES'}>&PrefetchedPublicMetadata;
const handles=new WeakMap<DurablePhaseMetadata,{metadata:PrefetchedPublicMetadata;binding:MetadataPhaseBinding;active:()=>boolean;used:boolean}>();
export function bindDurablePhaseMetadata(metadata:PrefetchedPublicMetadata,binding:MetadataPhaseBinding,active:()=>boolean):DurablePhaseMetadata{
 const check=()=>{if(!active())throw Error('durable_fee_phase_scope_invalid');};
 const handle=Object.freeze({kind:'DURABLE_PHASE_PUBLIC_BYTES' as const,read:async(path:string)=>{check();return metadata.read(path);},capture:()=>{check();return metadata.capture();}});
 handles.set(handle,{metadata,binding:Object.freeze({...binding}),active,used:false});return handle;
}
export function consumeDurablePhaseMetadata(handle:DurablePhaseMetadata,phase:MetadataPhaseBinding['phase'],scope:{owner:string;account:string;sha:string;policyHash:string},ticker:string){
 const h=handles.get(handle);
 if(!h||h.used||h.binding.phase!==phase||!h.active())throw Error('durable_fee_phase_scope_invalid');
 h.used=true;
 const clock=durablePhaseMetadataClock(h.metadata,scope,ticker,h.binding);
 return {metadata:h.metadata,startedAtMs:clock.startedAtMs,sourceFresh:()=>h.active()&&clock.sourceFresh()};
}
