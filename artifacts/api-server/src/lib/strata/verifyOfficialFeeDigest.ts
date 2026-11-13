import { establishOfficialFeeDigest } from "../microLiveFeeArtifact";

const result = await establishOfficialFeeDigest();
if (result.ok) {
  console.log(JSON.stringify({
    ok: true,
    digest: result.digest,
    httpStatus: result.diagnostic.httpStatus,
    networkAttempts: result.diagnostic.networkAttempts,
    contentType: result.diagnostic.contentType,
  }));
} else {
  console.log(JSON.stringify({
    ok: false,
    reason: result.reason,
    httpStatus: result.diagnostic.httpStatus,
    networkAttempts: result.diagnostic.networkAttempts,
    retryAfterSeconds: result.diagnostic.retryAfterSeconds,
    contentType: result.diagnostic.contentType,
  }));
  process.exitCode = 1;
}
