export type BuildMetadata={version:'STRATA_BUILD_V1';revision:string|null;tree:string|null;dirty:boolean|null;provenance:string;sourceSha256:string;sourceFiles:number;digestPolicy:string;executionAuthority:'NONE'};
export function captureBuildMetadata(root:string,roots:string[],env?:Record<string,string|undefined>):Readonly<BuildMetadata>;
