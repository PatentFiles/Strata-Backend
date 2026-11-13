const promiseWithResolvers = Promise as PromiseConstructor & {
  withResolvers?: <T>() => {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
};
if (typeof promiseWithResolvers.withResolvers !== "function") {
  Object.defineProperty(Promise, "withResolvers", {
    configurable: true,
    writable: true,
    value<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    },
  });
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  CANONICAL_FEE_SCHEDULE_URL, MAX_FEE_SCHEDULE_BYTES, STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
  STANDING_FEE_POLICY_VERSION, establishOfficialFeeDigest, parseFeeSchedulePdf, parseFeeScheduleText,
  verifyCurrentFeeArtifact, verifyOfficialFeePdfBytes,
  fetchTrustedFeeFromSupabaseBridge, establishVerifiedBridgeFeeDigest, officialFeeFetchDiagnostic,
} from "./microLiveFeeArtifact";

function examplePdf(text: string): Buffer {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 10 Tf 40 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1200 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

const pdf = examplePdf(
  "Kalshi Fee Schedule Effective July 7, 2026 General Trading Fees. The standard fee applies to all markets. Standard quadratic taker fee = 0.07 x contracts x price x 1 - price",
);
const digest = createHash("sha256").update(pdf).digest("hex");
const approval = {
  digest, policyVersion: STANDING_FEE_POLICY_VERSION,
  sourceUrl: CANONICAL_FEE_SCHEDULE_URL,
  formulaVersion: STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
};
function fetchPdf(bytes: Buffer, contentType = "application/pdf", status = 200): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), CANONICAL_FEE_SCHEDULE_URL);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    return new Response(new Uint8Array(bytes), {
      status,
      headers: { "content-type": contentType, "content-length": String(bytes.length) },
    });
  }) as typeof fetch;
}

test("parses the formula only in General Trading Fees with explicit universal applicability", async () => {
  const parsed = await parseFeeSchedulePdf(pdf);
  assert.equal(parsed?.effectiveDate, "2026-07-07");
  assert.equal(parsed?.formulaVersion, STANDARD_QUADRATIC_FEE_FORMULA_VERSION);
  assert.match(parsed?.evidence ?? "", /applies to all markets/i);
});

test("parses the actual July 7, 2026 Kalshi PDF, not its later general-fees table as the formula section", async () => {
  // The owner's uploaded document is the regression fixture. Keep its exact
  // bytes so PDF text extraction and the canonical-source digest are tested.
  const bytes = readFileSync(resolve(process.cwd(),
    "../../attached_assets/0_kalshi-fee-schedule_1790474920034.pdf"));
  const parsed = await parseFeeSchedulePdf(bytes);
  assert.equal(parsed?.effectiveDate, "2026-07-07");
  assert.equal(parsed?.formulaVersion, STANDARD_QUADRATIC_FEE_FORMULA_VERSION);
  assert.match(parsed?.evidence ?? "", /all event contract markets/i);
  assert.match(parsed?.evidence ?? "", /KXBTC15M absent/i);

  const verification = await verifyCurrentFeeArtifact({
    ...approval, digest: createHash("sha256").update(bytes).digest("hex"),
  }, fetchPdf(bytes));
  assert.equal(verification.valid, true);

  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const document = await loading.promise;
  try {
    assert.equal(document.numPages, 12);
    const pages: string[] = [];
    for (let index = 1; index <= document.numPages; index++) {
      const content = await (await document.getPage(index)).getTextContent();
      pages.push(content.items.map(item => "str" in item ? item.str : "").join(" "));
    }
    const text = pages.join(" ");
    assert.equal(parseFeeScheduleText(text.replace("KXBTCY", "KXBTC15M")), null);
    assert.equal(parseFeeScheduleText(text.replace("KXBTCY", "")), null);
    assert.equal(parseFeeScheduleText(text.replace(
      "Non-Standard Fees",
      "Bitcoin 15-minute markets have a zero taker multiplier. Non-Standard Fees",
    )), null);
    assert.equal(parseFeeScheduleText(text.replace("Non-Standard Fees", "Other Fees")), null);
    assert.equal(parseFeeScheduleText(text.replace("M x 0.07 x C", "M x 0.08 x C")), null);
    assert.equal(parseFeeScheduleText(text.replaceAll("July 7, 2026", "July 8, 2026")), null);
  } finally {
    await loading.destroy();
  }
});

test("rejects ambiguous special-market exceptions instead of inferring applicability", async () => {
  const ambiguous = examplePdf(
    "Kalshi Fee Schedule Effective July 7, 2026 General Trading Fees. The standard fee applies to all markets. Standard quadratic taker fee = 0.07 x contracts x price x 1 - price. Special market fee exceptions may apply.",
  );
  assert.equal(await parseFeeSchedulePdf(ambiguous), null);

  const namedOtherTicker = examplePdf(
    "Kalshi Fee Schedule Effective July 7, 2026 General Trading Fees. The standard fee applies to all markets. Standard quadratic taker fee = 0.07 x contracts x price x 1 - price. KXETH15M.",
  );
  assert.equal(await parseFeeSchedulePdf(namedOtherTicker), null);

  const unmappedBitcoinRate = examplePdf(
    "Kalshi Fee Schedule Effective July 7, 2026 General Trading Fees. The standard fee applies to all markets. Standard quadratic taker fee = 0.07 x contracts x price x 1 - price. Bitcoin market fee is 0.03.",
  );
  assert.equal(await parseFeeSchedulePdf(unmappedBitcoinRate), null);

  const contradictoryTarget = examplePdf(
    "Kalshi Fee Schedule Effective July 7, 2026 General Trading Fees. The standard fee applies to all markets. Standard quadratic taker fee = 0.07 x contracts x price x 1 - price. KXBTC15M fee is 0.03.",
  );
  assert.equal(await parseFeeSchedulePdf(contradictoryTarget), null);

  const secondRate = examplePdf(
    "Kalshi Fee Schedule Effective July 7, 2026 General Trading Fees. The standard fee applies to all markets. Standard quadratic taker fee = 0.07 x contracts x price x 1 - price. Maker rate is 0.03.",
  );
  assert.equal(await parseFeeSchedulePdf(secondRate), null);
});

test("does not use an unrelated 0.07 formula outside General Trading Fees", () => {
  const unrelated = [
    "Kalshi Fee Schedule Effective July 7, 2026.",
    "A separate product fee is 0.07 x contracts x price x 1 - price.",
    "General Trading Fees. The standard fee applies to all markets.",
    "The fee is described in this section.",
  ].join(" ");
  assert.equal(parseFeeScheduleText(unrelated), null);
});

test("verifies only exact canonical bytes, version, and formula", async () => {
  const result = await verifyCurrentFeeArtifact(approval, fetchPdf(pdf));
  assert.equal(result.valid, true);
  assert.equal(result.status, "verified");
  assert.equal(result.digest, digest);
});

test("fails closed for source errors, altered bytes, and unexpected content types", async () => {
  const unavailable = await verifyCurrentFeeArtifact(approval, fetchPdf(Buffer.alloc(0), "application/pdf", 429));
  assert.equal(unavailable.status, "unavailable");

  const changed = await verifyCurrentFeeArtifact(approval, fetchPdf(examplePdf(
    "Kalshi Fee Schedule Effective July 7, 2026 General Trading Fees. The standard fee applies to all markets. Standard quadratic taker fee = 0.08 x contracts x price x 1 - price",
  )));
  assert.equal(changed.status, "changed");

  const wrongType = await verifyCurrentFeeArtifact(approval, fetchPdf(pdf, "text/html"));
  assert.equal(wrongType.status, "invalid");
});

test("fails closed when fetched PDF is oversized or malformed", async () => {
  const oversized = new Response(new Uint8Array(2_000_001), {
    headers: { "content-type": "application/pdf" },
  });
  const oversizedFetch = (async () => oversized) as typeof fetch;
  const tooLarge = await verifyCurrentFeeArtifact(approval, oversizedFetch);
  assert.equal(tooLarge.status, "invalid");

  const malformed = await verifyCurrentFeeArtifact(approval, fetchPdf(Buffer.from("%PDF-not-the-approved-schedule")));
  assert.equal(malformed.status, "changed");

  const unreadablePdf = Buffer.concat([
    Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 0x20), Buffer.from("\n%%EOF"),
  ]);
  const unreadableApproval = {
    ...approval, digest: createHash("sha256").update(unreadablePdf).digest("hex"),
  };
  const unparsable = await verifyCurrentFeeArtifact(unreadableApproval, fetchPdf(unreadablePdf));
  assert.equal(unparsable.status, "invalid");
});

test("rejects arbitrary source URLs and unversioned formula identities before fetching", async () => {
  let calls = 0;
  const neverFetch = (async () => {
    calls += 1;
    throw new Error("must not fetch");
  }) as typeof fetch;
  const result = await verifyCurrentFeeArtifact({
    ...approval, sourceUrl: "https://example.invalid/fee.pdf",
  }, neverFetch);
  assert.equal(result.status, "invalid");
  assert.equal(calls, 0);

  const legacyMetadata = await verifyCurrentFeeArtifact({
    ...approval, sourceUrl: null, formulaVersion: null,
  } as unknown as typeof approval, neverFetch);
  assert.equal(legacyMetadata.status, "invalid");
  assert.equal(calls, 0);
});

function mockFeeResponse(options: {
  status?: number;
  contentType?: string;
  body?: Uint8Array;
  url?: string;
}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), CANONICAL_FEE_SCHEDULE_URL);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, undefined);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("accept"), "application/pdf");
    assert.equal(headers.get("cache-control"), "no-cache");
    assert.ok(init?.signal);
    const response = new Response(options.body ? new Uint8Array(options.body) : null, {
      status: options.status ?? 200,
      headers: {
        ...(options.contentType ? { "content-type": options.contentType } : {}),
        "set-cookie": "session=secret-cookie",
        "x-request-token": "secret-token",
      },
    });
    if (options.url !== undefined) Object.defineProperty(response, "url", { value: options.url });
    return response;
  }) as typeof fetch;
}

function assertSanitizedFeeResult(value: { diagnostic: { finalPathname: string | null } }): void {
  const encoded = JSON.stringify(value);
  assert.equal(encoded.includes("secret-cookie"), false);
  assert.equal(encoded.includes("secret-token"), false);
  assert.equal(encoded.includes("BODY-SECRET-MARKER"), false);
  assert.equal(encoded.includes("%PDF"), false);
  assert.equal(value.diagnostic.finalPathname?.includes("?"), false);
  assert.equal(value.diagnostic.finalPathname?.includes("#"), false);
}

test("200 application/pdf is not approval until the reviewed parser accepts the formula", async () => {
  const bytes = examplePdf("Kalshi document without a trading fee formula.");
  let calls = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(String(input), CANONICAL_FEE_SCHEDULE_URL);
    assert.equal(init?.method, "GET");
    return mockFeeResponse({
      contentType: "application/pdf",
      body: bytes,
      url: CANONICAL_FEE_SCHEDULE_URL,
    })(input, init);
  }) as typeof fetch;
  const result = await establishOfficialFeeDigest(fetchImpl);
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "official_fee_schedule_formula_unverifiable");
  assert.equal(result.diagnostic.httpStatus, 200);
  assert.equal(result.diagnostic.contentType, "application/pdf");
  assert.equal(result.diagnostic.finalOrigin, "https://kalshi.com");
  assert.equal(result.diagnostic.finalPathname, "/docs/kalshi-fee-schedule.pdf");
  assert.equal(result.diagnostic.networkAttempts, 1);
  assert.equal("digest" in result, false);
  assertSanitizedFeeResult(result);
});

test("official fee fetch reports HTTP 403 and 404 without the response body", async () => {
  const body = new TextEncoder().encode("<html>BODY-SECRET-MARKER</html>");
  const forbidden = await establishOfficialFeeDigest(mockFeeResponse({
    status: 403,
    contentType: "text/html",
    body,
    url: "https://user:secret-token@kalshi.com/docs/kalshi-fee-schedule.pdf?token=secret-token",
  }));
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) {
    assert.equal(forbidden.reason, "official_fee_schedule_http_403");
    assert.equal(forbidden.diagnostic.httpStatus, 403);
    assert.equal(forbidden.diagnostic.contentType, "text/html");
    assert.equal(forbidden.diagnostic.finalOrigin, null);
    assert.equal(forbidden.diagnostic.finalPathname, "/docs/kalshi-fee-schedule.pdf");
    assertSanitizedFeeResult(forbidden);
  }

  const missing = await establishOfficialFeeDigest(mockFeeResponse({
    status: 404,
    contentType: "text/html; charset=utf-8",
    body,
  }));
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.reason, "official_fee_schedule_http_404");
    assert.equal(missing.diagnostic.httpStatus, 404);
    assert.equal(missing.diagnostic.contentType, "text/html");
    assert.equal(missing.diagnostic.finalOrigin, "https://kalshi.com");
    assert.equal(missing.diagnostic.finalPathname, "/docs/kalshi-fee-schedule.pdf");
    assertSanitizedFeeResult(missing);
  }
});

test("official fee fetch rejects non-PDF content types", async () => {
  const body = new TextEncoder().encode("<html>BODY-SECRET-MARKER</html>");
  const html = await establishOfficialFeeDigest(mockFeeResponse({
    contentType: "text/html",
    body,
  }));
  assert.equal(html.ok, false);
  if (!html.ok) {
    assert.equal(html.reason, "official_fee_schedule_content_type_invalid");
    assert.equal(html.diagnostic.httpStatus, 200);
    assert.equal(html.diagnostic.contentType, "text/html");
    assertSanitizedFeeResult(html);
  }

  const bytes = await establishOfficialFeeDigest(mockFeeResponse({
    contentType: "application/octet-stream",
    body: pdf,
  }));
  assert.equal(bytes.ok, false);
  if (!bytes.ok) {
    assert.equal(bytes.reason, "official_fee_schedule_content_type_invalid");
    assert.equal(bytes.diagnostic.httpStatus, 200);
    assert.equal(bytes.diagnostic.contentType, "application/octet-stream");
    assertSanitizedFeeResult(bytes);
  }
});

test("official fee fetch rejects an oversized body and an invalid PDF", async () => {
  const oversized = await establishOfficialFeeDigest(mockFeeResponse({
    contentType: "application/pdf",
    body: new Uint8Array(MAX_FEE_SCHEDULE_BYTES + 1),
  }));
  assert.equal(oversized.ok, false);
  if (!oversized.ok) {
    assert.equal(oversized.reason, "official_fee_schedule_size_or_body_invalid");
    assert.equal(oversized.diagnostic.httpStatus, 200);
    assert.equal(oversized.diagnostic.contentType, "application/pdf");
    assertSanitizedFeeResult(oversized);
  }

  const invalid = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(120, 0x20)]);
  const unreadable = await establishOfficialFeeDigest(mockFeeResponse({
    contentType: "application/pdf",
    body: invalid,
  }));
  assert.equal(unreadable.ok, false);
  if (!unreadable.ok) {
    assert.equal(unreadable.reason, "official_fee_schedule_pdf_unparseable");
    assert.equal(unreadable.diagnostic.httpStatus, 200);
    assert.equal(unreadable.diagnostic.contentType, "application/pdf");
    assertSanitizedFeeResult(unreadable);
  }
});

test("one successful verification parses and hashes the same PDF bytes from one GET", async () => {
  let calls = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(String(input), CANONICAL_FEE_SCHEDULE_URL);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, undefined);
    assert.equal(String(input).includes("/portfolio/"), false);
    assert.equal(String(input).includes("/trade-api/"), false);
    const official = readFileSync(resolve(process.cwd(),
      "../../attached_assets/0_kalshi-fee-schedule_1790474920034.pdf"));
    return new Response(new Uint8Array(official), {
      status: 200,
      headers: { "content-type": "application/pdf", "content-length": String(official.length) },
    });
  }) as typeof fetch;
  const result = await establishOfficialFeeDigest(fetchImpl);
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const official = readFileSync(resolve(process.cwd(),
    "../../attached_assets/0_kalshi-fee-schedule_1790474920034.pdf"));
  assert.equal(result.digest, createHash("sha256").update(official).digest("hex"));
  assert.equal(result.diagnostic.httpStatus, 200);
  assert.equal(result.diagnostic.contentType, "application/pdf");
  assert.equal(result.diagnostic.finalOrigin, "https://kalshi.com");
  assert.equal(result.diagnostic.finalPathname, "/docs/kalshi-fee-schedule.pdf");
  assert.equal(result.diagnostic.retryAfterSeconds, null);
  assert.equal(result.diagnostic.networkAttempts, 1);
  assert.equal(JSON.stringify(result.diagnostic).includes("%PDF"), false);
  const source = readFileSync("src/lib/microLiveFeeArtifact.ts", "utf8");
  const establish = source.slice(source.indexOf("export async function establishOfficialFeeDigest"));
  assert.equal(establish.includes("verifyCurrentFeeArtifact"), false);
  assert.equal(establish.includes("/portfolio/"), false);
  assert.equal(establish.includes("/trade-api/"), false);
  assert.equal(establish.includes('method: "POST"'), false);
  assert.equal(establish.includes('method: "DELETE"'), false);
});

function sequencedFeeFetch(steps: Array<{
  status: number;
  contentType?: string;
  body?: Uint8Array;
  retryAfter?: string;
  url?: string;
}>): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(String(input), CANONICAL_FEE_SCHEDULE_URL);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, undefined);
    assert.equal(String(input).includes("/portfolio/"), false);
    const step = steps[calls - 1] ?? steps[steps.length - 1]!;
    const response = new Response(step.body ? new Uint8Array(step.body) : null, {
      status: step.status,
      headers: {
        ...(step.contentType ? { "content-type": step.contentType } : {}),
        ...(step.retryAfter !== undefined ? { "retry-after": step.retryAfter } : {}),
        "set-cookie": "session=secret-cookie",
        "x-request-token": "secret-token",
      },
    });
    if (step.url !== undefined) Object.defineProperty(response, "url", { value: step.url });
    return response;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls: () => calls };
}

test("429 without Retry-After performs one GET and stores nothing", async () => {
  const observed = sequencedFeeFetch([
    { status: 429, contentType: "text/plain", body: new TextEncoder().encode("BODY-SECRET-MARKER"), retryAfter: "secret-token" },
  ]);
  const result = await establishOfficialFeeDigest(observed.fetch);
  assert.equal(observed.calls(), 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "official_fee_schedule_http_429");
  assert.equal(result.diagnostic.httpStatus, 429);
  assert.equal(result.diagnostic.contentType, "text/plain");
  assert.equal(result.diagnostic.retryAfterSeconds, null);
  assert.equal(result.diagnostic.networkAttempts, 1);
  assert.equal("digest" in result, false);
  assertSanitizedFeeResult(result);

  const absent = sequencedFeeFetch([{ status: 429, contentType: "text/plain" }]);
  const plain = await establishOfficialFeeDigest(absent.fetch);
  assert.equal(absent.calls(), 1);
  assert.equal(plain.ok, false);
  if (!plain.ok) assert.equal(plain.diagnostic.retryAfterSeconds, null);
});

test("429 with a short Retry-After retries once and stores a digest only when the PDF validates", async () => {
  const recovered = sequencedFeeFetch([
    { status: 429, contentType: "text/plain", retryAfter: "0" },
    {
      status: 200,
      contentType: "application/pdf",
      body: readFileSync(resolve(process.cwd(), "../../attached_assets/0_kalshi-fee-schedule_1790474920034.pdf")),
      url: CANONICAL_FEE_SCHEDULE_URL,
    },
  ]);
  const success = await establishOfficialFeeDigest(recovered.fetch);
  assert.equal(recovered.calls(), 2);
  assert.equal(success.ok, true);
  if (!success.ok) return;
  const official = readFileSync(resolve(process.cwd(),
    "../../attached_assets/0_kalshi-fee-schedule_1790474920034.pdf"));
  assert.equal(success.digest, createHash("sha256").update(official).digest("hex"));
  assert.equal(success.diagnostic.httpStatus, 200);
  assert.equal(success.diagnostic.contentType, "application/pdf");
  assert.equal(success.diagnostic.retryAfterSeconds, null);
  assert.equal(success.diagnostic.networkAttempts, 2);

  const blocked = sequencedFeeFetch([
    { status: 429, contentType: "text/plain", retryAfter: "0" },
    { status: 429, contentType: "text/plain", retryAfter: "0", body: new TextEncoder().encode("BODY-SECRET-MARKER") },
  ]);
  const second = await establishOfficialFeeDigest(blocked.fetch);
  assert.equal(blocked.calls(), 2);
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, "official_fee_schedule_http_429");
  assert.equal(second.diagnostic.retryAfterSeconds, 0);
  assert.equal(second.diagnostic.networkAttempts, 2);
  assert.equal("digest" in second, false);
  assertSanitizedFeeResult(second);

  const later = sequencedFeeFetch([
    { status: 429, contentType: "text/plain", retryAfter: "16" },
  ]);
  const deferred = await establishOfficialFeeDigest(later.fetch);
  assert.equal(later.calls(), 1);
  assert.equal(deferred.ok, false);
  if (!deferred.ok) {
    assert.equal(deferred.diagnostic.retryAfterSeconds, 16);
    assert.equal(deferred.diagnostic.networkAttempts, 1);
    assert.equal("digest" in deferred, false);
  }
});

test("redirect mismatch and a changed PDF block without another GET", async () => {
  const redirected = sequencedFeeFetch([{
    status: 200,
    contentType: "application/pdf",
    body: pdf,
    url: "https://example.com/docs/kalshi-fee-schedule.pdf?token=secret-token",
  }]);
  const mismatch = await establishOfficialFeeDigest(redirected.fetch);
  assert.equal(redirected.calls(), 1);
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) {
    assert.equal(mismatch.reason, "official_fee_schedule_redirected");
    assert.equal(mismatch.diagnostic.finalOrigin, "https://example.com");
    assert.equal(mismatch.diagnostic.finalPathname, "/docs/kalshi-fee-schedule.pdf");
    assert.equal("digest" in mismatch, false);
    assertSanitizedFeeResult(mismatch);
  }

  const changedPdf = examplePdf(
    "Kalshi Fee Schedule Effective July 7, 2026 General Trading Fees. The standard fee applies to all markets. Standard quadratic taker fee = 0.08 x contracts x price x 1 - price",
  );
  const changed = sequencedFeeFetch([{
    status: 200,
    contentType: "application/pdf",
    body: changedPdf,
    url: CANONICAL_FEE_SCHEDULE_URL,
  }]);
  const rejected = await establishOfficialFeeDigest(changed.fetch);
  assert.equal(changed.calls(), 1);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.reason, "official_fee_schedule_formula_unverifiable");
    assert.equal("digest" in rejected, false);
  }
});

test("uploaded official fee bytes pass only the reviewed July 2026 PDF", async () => {
  const official = readFileSync(resolve(process.cwd(),
    "../../attached_assets/0_kalshi-fee-schedule_1790474920034.pdf"));
  const serverDigest = createHash("sha256").update(official).digest("hex");
  const accepted = await verifyOfficialFeePdfBytes(official);
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.digest, serverDigest);
  assert.equal(accepted.effectiveDate, "2026-07-07");
  assert.equal(accepted.formulaVersion, STANDARD_QUADRATIC_FEE_FORMULA_VERSION);
  const source = readFileSync("src/lib/microLiveFeeArtifact.ts", "utf8");
  const helper = source.slice(
    source.indexOf("export async function verifyOfficialFeePdfBytes"),
    source.indexOf("export interface OfficialFeeFetchDiagnostic"),
  );
  assert.equal(helper.includes("parseFeeSchedulePdf"), true);
  assert.equal(helper.includes("JULY_2026_TEXT_DIGEST"), true);
  assert.equal(helper.includes(serverDigest), false);
  assert.equal(source.includes(serverDigest), false);

  const lookalike = examplePdf(
    "Kalshi Fee Schedule Effective July 7, 2026 General Trading Fees. The standard fee applies to all markets. Standard quadratic taker fee = 0.07 x contracts x price x 1 - price",
  );
  const modified = await verifyOfficialFeePdfBytes(lookalike);
  assert.equal(modified.ok, false);
  if (!modified.ok) assert.equal(modified.reason, "unreviewed_schedule");

  const wrongFormula = await verifyOfficialFeePdfBytes(examplePdf(
    "Kalshi Fee Schedule Effective July 7, 2026 General Trading Fees. The standard fee applies to all markets. Standard quadratic taker fee = 0.08 x contracts x price x 1 - price",
  ));
  assert.equal(wrongFormula.ok, false);
  if (!wrongFormula.ok) assert.equal(wrongFormula.reason, "formula_unverifiable");

  const wrongDate = await verifyOfficialFeePdfBytes(examplePdf(
    "Kalshi Fee Schedule Effective July 8, 2026 General Trading Fees. The standard fee applies to all markets. Standard quadratic taker fee = 0.07 x contracts x price x 1 - price",
  ));
  assert.equal(wrongDate.ok, false);
  if (!wrongDate.ok) assert.equal(wrongDate.reason, "unreviewed_schedule");

  const oversized = await verifyOfficialFeePdfBytes(Buffer.alloc(MAX_FEE_SCHEDULE_BYTES + 1));
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.reason, "too_large");

  const notPdf = await verifyOfficialFeePdfBytes(Buffer.from("not a pdf document ".repeat(20)));
  assert.equal(notPdf.ok, false);
  if (!notPdf.ok) assert.equal(notPdf.reason, "invalid");
  assert.equal(JSON.stringify(accepted).includes("%PDF"), false);
});


test("trusted Supabase bridge requires exact project, official origin, fresh hash-bound PDF", async () => {
  const bytes = readFileSync(resolve(process.cwd(),
    "../../attached_assets/0_kalshi-fee-schedule_1790474920034.pdf"));
  const goodHash = createHash("sha256").update(bytes).digest("hex");
  const now = Date.parse("2026-10-15T20:00:00Z");
  const origin = "https://wqsmfbzfbiilhtzpqbrb.supabase.co";
  const anonJwt = "x".repeat(100);
  const props = {
    "content-type": "application/pdf",
    "x-strata-canonical-source": CANONICAL_FEE_SCHEDULE_URL,
    "x-strata-source-sha256": goodHash,
    "x-strata-captured-at": new Date(now - 5000).toISOString(),
  };
  const responding = (headers: Record<string,string>, body: Buffer = bytes,
    strictV4 = false) =>
    (async (url: string | Request | URL, init?: RequestInit) => {
      assert.equal(String(url), origin + "/functions/v1/strata-official-fee-source" +
        (strictV4 ? "?max_age_seconds=60" : ""));
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.equal((init?.headers as Record<string,string>).apikey, anonJwt);
      return new Response(new Uint8Array(body), { status: 200, headers });
    }) as typeof fetch;
  const result = await fetchTrustedFeeFromSupabaseBridge(responding(props), origin,
    anonJwt, () => now);
  assert.ok(result);
  assert.equal((await verifyOfficialFeePdfBytes(Buffer.from(await result!.arrayBuffer()))).ok, true);
  // V4 monetary model observation is stricter than the existing <=1h
  // infrastructure lease: a 60-second max capture age is mandatory.
  const recent=await fetchTrustedFeeFromSupabaseBridge(responding(props,bytes,true),origin,
    anonJwt,()=>now,60_000);
  assert.equal(recent?.status,200);
  const staleForV4=await fetchTrustedFeeFromSupabaseBridge(responding({
    ...props,"x-strata-captured-at":new Date(now-60_001).toISOString(),
  },bytes,true),origin,anonJwt,()=>now,60_000);
  assert.equal(staleForV4,null);
  assert.equal(await fetchTrustedFeeFromSupabaseBridge(responding(props),
    origin,anonJwt,()=>now,60*60*1000+1),null);
  assert.equal(await fetchTrustedFeeFromSupabaseBridge(responding(props),
    "https://wrong-project.supabase.co", anonJwt, () => now), null);
  assert.equal(await fetchTrustedFeeFromSupabaseBridge(responding({
    ...props, "x-strata-source-sha256": "0".repeat(64),
  }), origin, anonJwt, () => now), null);
  assert.equal(await fetchTrustedFeeFromSupabaseBridge(responding({
    ...props, "x-strata-canonical-source": "https://attacker.invalid/fee.pdf",
  }), origin, anonJwt, () => now), null);
  assert.equal(await fetchTrustedFeeFromSupabaseBridge(responding({
    ...props, "x-strata-captured-at": new Date(now - 3600001).toISOString(),
  }), origin, anonJwt, () => now), null);
  assert.equal(await fetchTrustedFeeFromSupabaseBridge(responding({
    ...props, "content-type": "text/html",
  }), origin, anonJwt, () => now), null);
  assert.equal(await fetchTrustedFeeFromSupabaseBridge(responding(props,
    Buffer.from("%PDF-tampered" + "x".repeat(500) + "%%EOF")),
    origin, anonJwt, () => now), null);
});


test("versioned V4 original issuer PDF remains hash-verified within 55m, not re-stamped",async()=>{
 const bytes=readFileSync(resolve(process.cwd(),"../../attached_assets/0_kalshi-fee-schedule_1790474920034.pdf"));
 const now=Date.parse("2026-10-15T20:00:00Z");
 const origin="https://wqsmfbzfbiilhtzpqbrb.supabase.co",jwt="x".repeat(100);
 const headers=(ageMs:number)=>({
  "content-type":"application/pdf",
  "x-strata-canonical-source":CANONICAL_FEE_SCHEDULE_URL,
  "x-strata-source-sha256":createHash("sha256").update(bytes).digest("hex"),
  "x-strata-captured-at":new Date(now-ageMs).toISOString(),
 });
 const request=(ageMs:number)=>(async(url:string|Request|URL)=>{
   assert.equal(String(url),origin+"/functions/v1/strata-official-fee-source?max_age_seconds=3300");
   return new Response(new Uint8Array(bytes),{status:200,headers:headers(ageMs)});
 }) as typeof fetch;
 const genuine=await fetchTrustedFeeFromSupabaseBridge(request(35*60_000),origin,jwt,()=>now,55*60_000);
 assert.equal(genuine?.status,200);
 // The verifier intentionally strips caller-visible attestation headers after
 // checking original timestamp + SHA-256 and returns ONLY the validated PDF.
 assert.equal(genuine?.headers.get("x-strata-captured-at"),null);
 assert.equal(genuine?.headers.get("x-strata-source-sha256"),null);
 assert.equal(createHash("sha256").update(Buffer.from(await genuine!.arrayBuffer())).digest("hex"),
  headers(35*60_000)["x-strata-source-sha256"]);
 assert.equal(await fetchTrustedFeeFromSupabaseBridge(request(55*60_000),origin,jwt,()=>now,55*60_000),null);
 assert.equal(await fetchTrustedFeeFromSupabaseBridge(request(-1000),origin,jwt,()=>now,55*60_000),null);
});

test("strict V4 official bridge cooldown never reuses stale PDF or approves fees",async()=>{
  const origin="https://wqsmfbzfbiilhtzpqbrb.supabase.co";
  const jwt="x".repeat(100);
  const called:string[]=[];
  const throttled=(async(input:string|Request|URL)=>{
    called.push(String(input));
    return new Response(JSON.stringify({ok:false,reason:"official_source_refresh_rate_limited_or_unavailable"}),
      {status:429,headers:{"content-type":"application/json","retry-after":"1690"}});
  }) as typeof fetch;
  const result=await fetchTrustedFeeFromSupabaseBridge(throttled,origin,jwt,Date.now,60_000);
  assert.equal(result?.status,429);
  assert.equal(result?.headers.get("retry-after"),"1690");
  assert.deepEqual(called,[origin+"/functions/v1/strata-official-fee-source?max_age_seconds=60"]);
  assert.equal(result?.headers.get("x-strata-source-sha256"),null);
});

test("trusted bridge cooldown reports retry without accepting any fee artifact", async () => {
  const origin = "https://wqsmfbzfbiilhtzpqbrb.supabase.co";
  const jwt = "x".repeat(100);
  const throttled = (async (url: string | Request | URL) => {
    assert.equal(String(url), origin + "/functions/v1/strata-official-fee-source");
    return new Response(JSON.stringify({
      ok: false, reason: "official_source_refresh_rate_limited_or_unavailable",
    }), { status: 429, headers: {
      "content-type": "application/json", "retry-after": "1270",
    } });
  }) as typeof fetch;
  const result = await fetchTrustedFeeFromSupabaseBridge(throttled, origin, jwt);
  assert.equal(result?.status, 429);
  assert.equal(result?.headers.get("retry-after"), "1270");
  assert.notEqual(result?.headers.get("content-type"), "application/pdf");
  // Reject unbounded retry headers rather than deriving authority from them.
  const unbounded = (async () => new Response("{}", { status: 429, headers: {
    "content-type": "application/json", "retry-after": "999999",
  } })) as typeof fetch;
  assert.equal(await fetchTrustedFeeFromSupabaseBridge(unbounded, origin, jwt), null);
});

test("Edge 429 identifies shared lease versus provider and preserves exact UTC retry deadline",async()=>{
 const origin="https://wqsmfbzfbiilhtzpqbrb.supabase.co",jwt="x".repeat(100);
 const now=Date.parse("2026-10-24T22:17:00.000Z"),retryAt="2026-10-24T22:46:58.810Z";
 for(const source of ["shared_cooldown","provider"]){
  const edge=(async()=>new Response("{}",{status:429,headers:{
   "content-type":"application/json","retry-after":"1799",
   "x-strata-fee-429-origin":source,"x-strata-next-allowed-at":retryAt,
  }})) as typeof fetch;
  const resp=await fetchTrustedFeeFromSupabaseBridge(edge,origin,jwt,()=>now);
  assert.equal(resp?.status,429);
  const observed=officialFeeFetchDiagnostic(resp!,0);
  assert.equal(observed.rateLimitOrigin,source);
  assert.equal(observed.retryAt,retryAt);
  assert.equal(resp?.headers.get("x-strata-source-sha256"),null);
  const denied=await establishVerifiedBridgeFeeDigest(edge,origin,jwt,()=>now);
  assert.equal(denied?.ok,false);
  assert.equal(denied?.diagnostic.retryAt,retryAt);
 }
 const unknown=(async()=>new Response("{}",{status:429,headers:{
  "content-type":"application/json","retry-after":"120",
  "x-strata-fee-429-origin":"unsafe_unknown",
  "x-strata-next-allowed-at":"not-an-iso-date",
 }})) as typeof fetch;
 const resp=await fetchTrustedFeeFromSupabaseBridge(unknown,origin,jwt,()=>now);
 assert.equal(officialFeeFetchDiagnostic(resp!,0).rateLimitOrigin,"bridge_unclassified");
 assert.equal(officialFeeFetchDiagnostic(resp!,0).retryAt,null);
});
test("429 cooldown respects Retry-After and never treats previous bytes as current evidence", async () => {
  let clock = 1_000_000;
  const official = readFileSync(resolve(process.cwd(),
    "../../attached_assets/0_kalshi-fee-schedule_1790474920034.pdf"));
  const sequence = sequencedFeeFetch([
    { status: 429, contentType: "text/plain", retryAfter: "90" },
    { status: 200, contentType: "application/pdf", body: official,
      url: CANONICAL_FEE_SCHEDULE_URL },
  ]);
  const first = await establishOfficialFeeDigest(sequence.fetch, () => clock);
  assert.equal(first.ok, false);
  assert.equal(sequence.calls(), 1);

  const paused = await establishOfficialFeeDigest(sequence.fetch, () => clock);
  assert.equal(paused.ok, false);
  assert.equal(sequence.calls(), 1, "no extra Kalshi GET during cooldown");
  if (!paused.ok) {
    assert.equal(paused.reason, "official_fee_schedule_http_429");
    assert.equal(paused.diagnostic.httpStatus, 429);
    assert.equal(paused.diagnostic.retryAfterSeconds, 90);
    assert.equal(paused.diagnostic.networkAttempts, 0);
    assert.equal("digest" in paused, false);
  }
  clock += 90_000;
  const recovered = await establishOfficialFeeDigest(sequence.fetch, () => clock);
  assert.equal(recovered.ok, true);
  assert.equal(sequence.calls(), 2, "recovery requires new official bytes");
  const next = await establishOfficialFeeDigest(sequence.fetch, () => clock);
  assert.equal(next.ok, true);
  assert.equal(sequence.calls(), 3, "success must never be cached for future approvals");
});

test("repeated Kalshi 429s back off 60s, 120s, 240s without approving or caching bytes", async () => {
  let clock = 2_000_000;
  const seq = sequencedFeeFetch([
    { status: 429, contentType: "text/plain" },
    { status: 429, contentType: "text/plain" },
    { status: 429, contentType: "text/plain" },
  ]);
  for (const [index, expectedCooldown] of [60, 120, 240].entries()) {
    const blocked = await establishOfficialFeeDigest(seq.fetch, () => clock);
    assert.equal(blocked.ok, false);
    assert.equal(seq.calls(), index + 1, "at most one new GET after each cooldown");
    const stillBlocked = await establishOfficialFeeDigest(seq.fetch, () => clock);
    assert.equal(stillBlocked.ok, false);
    assert.equal(seq.calls(), index + 1, "no extra GET while fee source is blocked");
    if (!stillBlocked.ok) {
      assert.equal(stillBlocked.reason, "official_fee_schedule_http_429");
      assert.equal(stillBlocked.diagnostic.retryAfterSeconds, expectedCooldown);
      assert.equal(stillBlocked.diagnostic.networkAttempts, 0);
      assert.equal("digest" in stillBlocked, false);
    }
    clock += expectedCooldown * 1000;
  }
});

test("injected fee transports cannot access the privileged production bridge after 429", async () => {
  const oldFetch = globalThis.fetch;
  const oldUrl = process.env.SUPABASE_URL;
  const oldJwt = process.env.STRATA_FEE_BRIDGE_ANON_JWT;
  let canonicalGets = 0;
  let bridgeGets = 0;
  try {
    process.env.SUPABASE_URL = "https://wqsmfbzfbiilhtzpqbrb.supabase.co";
    process.env.STRATA_FEE_BRIDGE_ANON_JWT = "x".repeat(100);
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input) === CANONICAL_FEE_SCHEDULE_URL) {
        canonicalGets++;
        return new Response("provider throttle", { status: 429,
          headers: { "content-type": "text/plain" } });
      }
      bridgeGets++;
      throw new Error("unexpected privileged bridge call from injected transport");
    }) as typeof fetch;
    const blocked = await verifyCurrentFeeArtifact(approval);
    assert.equal(blocked.status, "unavailable");
    assert.equal(blocked.valid, false);
    assert.equal(blocked.reason, "official_fee_schedule_http_429");
    assert.equal(canonicalGets, 1);
    assert.equal(bridgeGets, 0, "only the captured production transport can use bridge fallback");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = oldUrl;
    if (oldJwt === undefined) delete process.env.STRATA_FEE_BRIDGE_ANON_JWT;
    else process.env.STRATA_FEE_BRIDGE_ANON_JWT = oldJwt;
  }
});

test("simultaneous official fee validations use one network request, without caching success", async () => {
  let calls = 0;
  const official = readFileSync(resolve(process.cwd(),
    "../../attached_assets/0_kalshi-fee-schedule_1790474920034.pdf"));
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    await Promise.resolve();
    return mockFeeResponse({
      contentType: "application/pdf",
      body: official,
      url: CANONICAL_FEE_SCHEDULE_URL,
    })(input, init);
  }) as typeof fetch;
  const [left, right] = await Promise.all([
    establishOfficialFeeDigest(fetchImpl),
    establishOfficialFeeDigest(fetchImpl),
  ]);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.equal(calls, 1);
  await establishOfficialFeeDigest(fetchImpl);
  assert.equal(calls, 2, "next request independently checks the source");
});


test("renewable, fresh official Edge PDF proof must pass canonical origin, captured hash, age and full reviewed parser",async()=>{
 const bytes=readFileSync(resolve(process.cwd(),"../../attached_assets/0_kalshi-fee-schedule_1790474920034.pdf"));
 const checkedAt=Date.parse("2026-10-21T02:05:00Z");
 const project="https://wqsmfbzfbiilhtzpqbrb.supabase.co";
 const jwt="t".repeat(100);
 const headers={
  "content-type":"application/pdf",
  "x-strata-canonical-source":CANONICAL_FEE_SCHEDULE_URL,
  "x-strata-source-sha256":createHash("sha256").update(bytes).digest("hex"),
  "x-strata-captured-at":new Date(checkedAt-1000).toISOString(),
 };
 const response=(h:Record<string,string>,data:Buffer=bytes) => (async()=>{
   return new Response(new Uint8Array(data),{status:200,headers:h});
 }) as typeof fetch;
 const verified=await establishVerifiedBridgeFeeDigest(response(headers),project,jwt,()=>checkedAt);
 assert.equal(verified?.ok,true);
 assert.equal(verified&&verified.ok&&verified.digest,createHash("sha256").update(bytes).digest("hex"));
 const expired=await establishVerifiedBridgeFeeDigest(response({...headers,
   "x-strata-captured-at":new Date(checkedAt-3_600_100).toISOString()}),project,jwt,()=>checkedAt);
 assert.equal(expired,null);
 const otherSource=await establishVerifiedBridgeFeeDigest(response({...headers,
   "x-strata-canonical-source":"https://different.example/fees.pdf"}),project,jwt,()=>checkedAt);
 assert.equal(otherSource,null);
 const tampered=await establishVerifiedBridgeFeeDigest(response({...headers,
   "x-strata-source-sha256":"f".repeat(64)}),project,jwt,()=>checkedAt);
 assert.equal(tampered,null);
 const changed=Buffer.from("%PDF-fabricated\\n"+"M".repeat(250)+"\\n%%EOF");
 const changedDigest=createHash("sha256").update(changed).digest("hex");
 const altered=await establishVerifiedBridgeFeeDigest(response({...headers,
   "x-strata-source-sha256":changedDigest},changed),project,jwt,()=>checkedAt);
 assert.equal(altered?.ok,false);
 assert.equal(JSON.stringify(altered).includes("PRIVATE_KEY"),false);
 const rateLimited=(async()=>new Response(null,{status:429,headers:{"content-type":"application/json","retry-after":"60"}})) as typeof fetch;
 const blockedBridge=await establishVerifiedBridgeFeeDigest(rateLimited,project,jwt,()=>checkedAt);
 assert.equal(blockedBridge?.ok,false);
 assert.equal(blockedBridge?.reason,"official_fee_schedule_http_429");
 assert.equal(blockedBridge?.diagnostic.rateLimitOrigin,"bridge_unclassified");
 const wrongProject=await establishVerifiedBridgeFeeDigest(response(headers),"https://attacker.invalid",jwt,()=>checkedAt);
 assert.equal(wrongProject,null);
});

test("production monetary PDF authority uses one shared provider lease and never a pinned fixture",()=>{
  const source=readFileSync("src/lib/microLiveFeeArtifact.ts","utf8");
  const body=source.slice(source.indexOf("async function fetchOfficialFeeSchedule("),
    source.indexOf("/**\n * Validate one official PDF response."));
  assert.match(body,/fetchImpl===PRODUCTION_FEE_FETCH/);
  assert.match(body,/fetchTrustedFeeFromSupabaseBridge\(PRODUCTION_FEE_FETCH/);
  assert.match(body,/Date\.now,60_000/);
  assert.match(body,/throw Error\("official_fee_capture_gate_unavailable"\)/);
  assert.doesNotMatch(body,/recentPinnedOfficialFeeSnapshot\(/);
  assert.doesNotMatch(body,/if\s*\(alternate\?\.status\s*===\s*200\)/);
  const edge=source.slice(source.indexOf("export async function readUnapprovedOfficialFeePublication"),
    source.indexOf("async function readPdfWithinLimit"));
  assert.match(edge,/if\(!directSuppressed&&!centrallyGated\)/);
  assert.match(edge,/const canBridge=centrallyGated/);
  assert.match(edge,/process\.env\.STRATA_FEE_BRIDGE_ANON_JWT,nowMs,V4_VERSIONED_ISSUER_LEASE_MS\)/);
  assert.doesNotMatch(edge,/process\.env\.STRATA_FEE_BRIDGE_ANON_JWT,nowMs,60_000\)/);
  assert.match(edge,/response=verified; \/\/ Genuine rate-limit denial/);
  assert.doesNotMatch(edge,/recentPinnedOfficialFeeSnapshot\(/);
});
