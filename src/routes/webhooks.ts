import crypto from "node:crypto";
import { Router } from "express";
import { config, hasWebhookSecret } from "../config.js";
import { PaymentStore } from "../database/store.js";
import { ShopifyClient } from "../shopify/client.js";

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

function timingSafeEqualHex(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(received, "hex");
  return expectedBuffer.length > 0 && expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function parseSignature(header: string): { timestamp?: string; signatures: string[] } {
  const signatures: string[] = [];
  let timestamp: string | undefined;
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (!value) continue;
    if (key === "t") timestamp = value;
    if (["v1", "sha256", "signature", "sig"].includes(key)) signatures.push(value.replace(/^sha256=/i, "").trim());
  }
  if (!signatures.length) signatures.push(header.replace(/^sha256=/i, "").trim());
  return { timestamp, signatures: signatures.filter(Boolean) };
}

function verifySignature(rawBody: Buffer, header: string | undefined): { valid: boolean; timestamp?: string } {
  if (!hasWebhookSecret() || !header) return { valid: false };
  const { timestamp, signatures } = parseSignature(header);
  const secret = config.payco.webhookSecret!;
  const signedValues = [
    rawBody,
    ...(timestamp ? [Buffer.from(`${timestamp}.${rawBody.toString("utf8")}`)] : []),
  ];
  const valid = signedValues.some((value) => {
    const expected = crypto.createHmac("sha256", secret).update(value).digest("hex");
    return signatures.some((candidate) => timingSafeEqualHex(expected, candidate));
  });
  return { valid, timestamp };
}

function extractEvent(payload: Record<string, any>, headers: Record<string, any>) {
  const data = asRecord(payload.data);
  const eventType = String(headers["x-pay-event"] || payload.event || payload.type || payload.name || payload.event_type || "unknown");
  const eventId = String(headers["x-pay-event-id"] || payload.event_id || payload.eventId || payload.id || "");
  const timestamp = String(payload.created_at || payload.createdAt || "");
  const chargeId = [data.id, data.charge_id, data.chargeId, payload.charge_id, payload.chargeId]
    .find((value) => typeof value === "string" || typeof value === "number");
  const reference = [data.reference, data.transaction_reference, data.merchant_reference, payload.reference]
    .find((value) => typeof value === "string" || typeof value === "number");
  return {
    eventId,
    eventType,
    timestamp,
    chargeId: chargeId ? String(chargeId) : undefined,
    reference: reference ? String(reference) : undefined,
  };
}

function isOldEvent(timestamp: string, toleranceSeconds: number): boolean {
  if (!timestamp) return false;
  const numeric = Number(timestamp);
  const eventTime = Number.isFinite(numeric) ? (numeric > 10_000_000_000 ? numeric : numeric * 1000) : Date.parse(timestamp);
  if (!Number.isFinite(eventTime)) return true;
  return Math.abs(Date.now() - eventTime) > toleranceSeconds * 1000;
}

export function createWebhooksRouter(store: PaymentStore, shopify: ShopifyClient): Router {
  const router = Router();

  router.post("/pay", async (req, res, next) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const signature = req.header("X-Pay-Signature");

    if (!hasWebhookSecret()) {
      res.status(503).json({ error: "PAYCO_WEBHOOK_SECRET não está configurado." });
      return;
    }

    const verified = verifySignature(rawBody, signature);
    if (!verified.valid) {
      res.status(401).json({ error: "Assinatura do webhook inválida." });
      return;
    }

    let payload: Record<string, any>;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as Record<string, any>;
    } catch {
      res.status(400).json({ error: "JSON inválido." });
      return;
    }

    const event = extractEvent(payload, req.headers);
    if (!event.eventId) {
      res.status(400).json({ error: "X-Pay-Event-Id ou id do evento é obrigatório." });
      return;
    }
    if (isOldEvent(verified.timestamp || event.timestamp, config.webhookToleranceSeconds)) {
      res.status(401).json({ error: "Evento antigo rejeitado." });
      return;
    }

    const claimed = store.claimWebhookEvent(event.eventId, event.eventType);
    if (!claimed.isNew && claimed.status === "processed") {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }

    try {
      const payment =
        (event.chargeId && store.getPaymentByPayChargeId(event.chargeId)) ||
        (event.reference && store.getPaymentByPayReference(event.reference));

      if (!payment) {
        store.log("webhook.pay", "warn", "Evento recebido sem pagamento correspondente.", event.eventId, event);
        store.completeWebhookEvent(event.eventId);
        res.status(202).json({ received: true, matched: false });
        return;
      }

      const normalizedType = event.eventType.toLowerCase();
      if (["payment.succeeded", "payment_success", "succeeded"].includes(normalizedType)) {
        if (payment.status !== "succeeded") {
          await shopify.markOrderPaid(
            payment.shopifyOrderId,
            ((payment.amountMinor || 0) / 100).toFixed(2),
            payment.currency || "MZN",
            payment.payChargeId || event.chargeId || "pay",
          );
          store.updatePayment(payment.id, {
            status: "succeeded",
            completedAt: new Date().toISOString(),
            failureReason: null,
          });
          store.log("webhook.pay", "info", "Pagamento confirmado e pedido Shopify atualizado.", String(payment.id), event);
        }
      } else if (["payment.failed", "payment_failed", "failed"].includes(normalizedType)) {
        store.updatePayment(payment.id, {
          status: "failed",
          failureReason: String(asRecord(payload.data).failure_reason || payload.failure_reason || "Pagamento recusado pela PAY."),
        });
        store.log("webhook.pay", "warn", "Pagamento recusado pela PAY.", String(payment.id), event);
      } else {
        store.log("webhook.pay", "info", `Evento PAY ignorado: ${event.eventType}.`, String(payment.id), event);
      }

      store.completeWebhookEvent(event.eventId);
      res.status(200).json({ received: true });
    } catch (error) {
      store.failWebhookEvent(event.eventId, error instanceof Error ? error.message : "Falha ao processar webhook.");
      store.log("webhook.pay", "error", "Falha ao processar webhook.", event.eventId, {
        error: error instanceof Error ? error.message : error,
      });
      next(error);
    }
  });

  return router;
}
