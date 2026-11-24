/** Opt-in manual publication mode. Never implies live trading authorization. */
export const platformFeeUploadEnabled=(env:NodeJS.ProcessEnv=process.env)=>env.STRATA_PLATFORM_FEE_UPLOAD_ENABLED==="true";
export const PLATFORM_UPLOAD_CONFIRM="PUBLISH_PLATFORM_KALSHI_FEE_PDF_V1";
export const PLATFORM_UPLOAD_PREVIEW="REVIEW_PLATFORM_KALSHI_FEE_PDF_V1";
export const UPLOADED_FEE_MIGRATION_CONFIRM="I_APPROVE_ADMIN_UPLOADED_KALSHI_FEE_TERMS_V1";
export const UPLOADED_FEE_PROVENANCE="ADMIN_UPLOADED_FEE_SCHEDULE" as const;
export const isUploadedBaselineId=(id:unknown):id is string=>typeof id==="string"&&/^platform-upload-[a-f0-9]{64}$/.test(id);
