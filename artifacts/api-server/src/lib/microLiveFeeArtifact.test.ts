import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  CANONICAL_FEE_SCHEDULE_URL, STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
  STANDING_FEE_POLICY_VERSION, parseFeeSchedulePdf, parseFeeScheduleText,
  verifyCurrentFeeArtifact,
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