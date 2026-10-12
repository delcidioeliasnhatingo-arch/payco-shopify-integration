import test from "node:test";
import assert from "node:assert/strict";

test("PAY.co.mz currency conversion", async (t) => {
  process.env.PAYCO_USD_MZN_RATE = "63.5";
  const { convertToPaycoMzn } = await import("../src/payco/client.js");

  await t.test("keeps MZN amounts unchanged to two decimals", () => {
    assert.equal(convertToPaycoMzn("120.5", "MZN"), "120.50");
  });

  await t.test("converts USD using the configured rate", () => {
    assert.equal(convertToPaycoMzn("10", "USD"), "635.00");
  });

  await t.test("rejects unsupported currencies", () => {
    assert.throws(() => convertToPaycoMzn("10", "CAD"), /não tem conversão configurada/);
  });
});
