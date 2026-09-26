import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PaymentStore } from "../src/database/store.js";

test("reserva um pedido uma única vez", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "payco-store-"));
  const store = new PaymentStore(path.join(directory, "payments.db"));

  const first = store.reservePayment("1001", "gid://shopify/Order/1001", "mpesa");
  const second = store.reservePayment("1001", "gid://shopify/Order/1001", "mpesa");

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.payment.id, second.payment.id);
  assert.equal(second.payment.status, "creating");
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("registra e deduplica eventos do webhook", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "payco-webhook-"));
  const store = new PaymentStore(path.join(directory, "payments.db"));

  assert.deepEqual(store.claimWebhookEvent("evt-1", "payment.succeeded"), {
    isNew: true,
    status: "processing",
  });
  store.completeWebhookEvent("evt-1");
  assert.deepEqual(store.claimWebhookEvent("evt-1", "payment.succeeded"), {
    isNew: false,
    status: "processed",
  });
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});