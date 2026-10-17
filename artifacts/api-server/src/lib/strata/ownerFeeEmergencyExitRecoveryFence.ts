/**
 * REVIEW-ONLY recovery state model for a future signed Kalshi IOC exit dispatcher.
 *
 * This code has ZERO credentials, transport, database writes, or trading authority.
 * A future dispatcher MUST durably commit UNKNOWN with the immutable reservation
 * and an owned worker lease BEFORE attempting a network POST. In-memory calls
 * to this reducer are NOT evidence of such a durable commit.
 *
 * A network timeout, crash, ambiguous receipt or wrong history never permits a
 * second POST. Even a reconciled zero-fill IOC is terminal for the same attempt.
 */
import {
  reconcileIocEmergencyExit,
  type IocRecoveryObservation,
} from "./ownerFeeEmergencyExitReconcile";

export type RecoveryPhase = "PREPARED" | "UNKNOWN" | "RECONCILED";
export interface EmergencyRecoveryRecord {
  reservationId: string;
  ownerUserId: string;
  accountId: string;
  marketTicker: string;
  clientOrderId: string;
  orderDigest: string;
  workerFencingToken: number;
  initialPositionFp: string;
  requestedCountFp: string;
  reducingBookSide: "bid" | "ask";
  phase: RecoveryPhase;
  attemptRecorded: boolean;
}
export type EmergencyRecoveryEvent =
  | {kind:"begin_attempt";reservationId:string;ownerUserId:string;accountId:string;
     orderDigest:string;workerFencingToken:number}
  | {kind:"exchange_observation";observation:IocRecoveryObservation};

export interface RecoveryFenceDecision {
  record: EmergencyRecoveryRecord;
  changed: boolean;
  reason: string;
  /** This state machine never grants exchange POST authority. */
  tradingAuthorized: false;
  mayRetry: false;
  transportAuthorized: false;
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CID=/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MARKET=/^KXBTC15M-[A-Za-z0-9-]+$/;
const DIGEST=/^[0-9a-f]{64}$/;
const COUNT=/^\d{1,9}\.\d{2}$/;
const ACCOUNT=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function validRecord(x: EmergencyRecoveryRecord): boolean {
  return UUID.test(x.reservationId) && UUID.test(x.ownerUserId) &&
    ACCOUNT.test(x.accountId) && MARKET.test(x.marketTicker) &&
    CID.test(x.clientOrderId) && DIGEST.test(x.orderDigest) &&
    Number.isSafeInteger(x.workerFencingToken) && x.workerFencingToken>0 &&
    COUNT.test(x.requestedCountFp) &&
    /^-?\d{1,9}\.\d{2}$/.test(x.initialPositionFp) &&
    (x.reducingBookSide==="ask"||x.reducingBookSide==="bid") &&
    ["PREPARED","UNKNOWN","RECONCILED"].includes(x.phase) &&
    typeof x.attemptRecorded==="boolean" &&
    (x.phase==="PREPARED" ? !x.attemptRecorded : x.attemptRecorded);
}
const deny=(record:EmergencyRecoveryRecord,reason:string):RecoveryFenceDecision=>({
  record,changed:false,reason,tradingAuthorized:false,
  mayRetry:false,transportAuthorized:false,
});

/**
 * Pure transition proof. No caller can interpret changed=true as order
 * authorization; the actual ledger must commit the change under ownership,
 * active worker lease, exact fee proof and an independent dispatch policy.
 */
export function inspectExitRecoveryTransition(
  record:EmergencyRecoveryRecord,
  event:EmergencyRecoveryEvent,
):RecoveryFenceDecision {
  if(!validRecord(record))return deny(record,"recovery_reservation_unverified");
  if(event.kind==="begin_attempt"){
    if(record.phase!=="PREPARED"||record.attemptRecorded)
      return deny(record,"recovery_attempt_already_recorded");
    if(event.reservationId!==record.reservationId||
       event.ownerUserId!==record.ownerUserId||
       event.accountId!==record.accountId||
       event.orderDigest!==record.orderDigest||
       event.workerFencingToken!==record.workerFencingToken)
      return deny(record,"recovery_dispatch_fence_mismatch");
    return {
      ...deny({...record,phase:"UNKNOWN",attemptRecorded:true},
        "recovery_unknown_must_be_committed_before_any_transport"),
      changed:true,
    };
  }
  if(record.phase!=="UNKNOWN"||!record.attemptRecorded)
    return deny(record,"recovery_not_pending");
  const obs=event.observation;
  if(!obs||obs.clientOrderId!==record.clientOrderId||
     obs.marketTicker!==record.marketTicker||
     obs.positionMarketTicker!==record.marketTicker||
     obs.requestedCountFp!==record.requestedCountFp||
     obs.initialPositionFp!==record.initialPositionFp||
     obs.reducingBookSide!==record.reducingBookSide)
    return deny(record,"recovery_observation_wrong_reservation");
  const proof=reconcileIocEmergencyExit(obs);
  if(proof.state!=="RECONCILED")
    return deny(record,proof.reason);
  return {
    ...deny({...record,phase:"RECONCILED"},
      "recovery_reconciled_terminal_no_retry"),
    changed:true,
  };
}
