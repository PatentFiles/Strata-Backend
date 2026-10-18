export const FEE_SOURCE_DECISION_TEXT = `STRATA_OPERATOR_FEE_SOURCE_POLICY_V2
Scope: Kalshi KXBTC15M, exchange index 2, reviewed PDF SHA-256 c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601.
The operator-uploaded PDF is not a Kalshi-origin authenticated source capture.
Alternative fee-source authorization requires one authenticated administrator source review, a separately confirmed short-lived operator-attested release, one administrator review of the exact owner-specific policy, an explicit owner-scoped grant, separately recorded owner consent, and fresh market-specific Kalshi Trade API evidence at Step 6, Step 9, Step 11 and final order-submission checks.
The grant never approves a risk policy, commissions an account, arms a worker, changes kill switches, or authorizes funds or trading by itself.
Existing C52/C53 strategy and quantitative fee, rounding, exposure and protective-exit rules are unchanged.
Expiry, revocation, missing authorization, malformed evidence, changed fees, stale prices, unexpected overrides or scheduled changes, exchange mismatch, incorrect owner or market, and API failures must fail closed; no new order is authorized.
` as const;
export const FEE_SOURCE_DECISION_SHA256 = "0e5d3cdaeba8c26bf54cb7c159ac14c9032180e24078c262ebe3290d8228918c" as const;
export const FEE_SOURCE_REVIEW_CONFIRMATION = "I_APPROVE_STRATA_OPERATOR_FEE_SOURCE_POLICY_V2" as const;
export const FEE_SOURCE_GRANT_CONFIRMATION = "ISSUE_OWNER_SCOPED_OPERATOR_FEE_SOURCE_GRANT" as const;
export const REVIEWED_OPERATOR_FEE_SHA256 =
  "c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601" as const;
