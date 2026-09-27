import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { PaymentStore } from "../database/store.js";
import { PaycoClient } from "../payco/client.js";
import { ShopifyClient } from "../shopify/client.js";

const paymentRequestSchema = z.object({
  shopifyOrderId: z.union([z.string(), z.number()]).transform(String),
  paymentMethod: z.enum(["mpesa", "mkesh", "card"]).default("mpesa"),
  customer: z.object({
    name: z.string().trim().max(120).optional(),
    email: z.string().email().optional(),
    phone: z.string().trim().max(40).optional(),
  }).optional(),
});

function publicPayment(payment: ReturnType<PaymentStore["getPaymentById"]>) {
  if (!payment) return null;
  return {
    id: payment.id,
    shopifyOrderId: payment.shopifyOrderId,
    payChargeId: payment.payChargeId,
    payReference: payment.payReference,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    paymentMethod: payment.paymentMethod,
    checkoutUrl: payment.checkoutUrl,
    status: payment.status,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
    completedAt: payment.completedAt,
    failureReason: payment.failureReason,
  };
}

export function createPaymentsRouter(store: PaymentStore, payco: PaycoClient, shopify: ShopifyClient): Router {
  const router = Router();

  router.post("/", async (req, res, next) => {
    try {
      const parsed = paymentRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });
        return;
      }

      const existing = store.getPaymentByShopifyOrderId(parsed.data.shopifyOrderId);
      if (existing && existing.status !== "failed" && existing.checkoutUrl) {
        res.status(200).json({ payment: publicPayment(existing), reused: true });
        return;
      }

      const reservation = store.reservePayment(parsed.data.shopifyOrderId, null, parsed.data.paymentMethod);
      if (!reservation.created) {
        if (reservation.payment.status === "failed") {
          res.status(409).json({ error: "Já existe uma tentativa falhada para este pedido.", payment: publicPayment(reservation.payment) });
          return;
        }
        if (!reservation.payment.checkoutUrl) {
          res.status(409).json({ error: "Já existe uma cobrança em criação para este pedido." });
          return;
        }
        res.status(200).json({ payment: publicPayment(reservation.payment), reused: true });
        return;
      }

      const payment = reservation.payment;
      try {
        const order = await shopify.getOrder(parsed.data.shopifyOrderId);
        const customer = parsed.data.customer || order.customer;

        store.updatePayment(payment.id, {
          shopifyOrderGid: order.gid,
          amountMinor: Math.round(Number(order.amount) * 100),
          currency: order.currency,
        });

        const charge = await payco.createCharge({
          amount: order.amount,
          method: parsed.data.paymentMethod,
          idempotencyKey: `shopify-order-${order.id}`,
          customer,
        });

        const updated = store.updatePayment(payment.id, {
          payChargeId: charge.id,
          payReference: charge.reference,
          amountMinor: Math.round(Number(order.amount) * 100),
          currency: order.currency,
          paymentMethod: parsed.data.paymentMethod,
          checkoutUrl: charge.checkoutUrl,
          status: "pending",
          failureReason: null,
        });
        store.log("payment.create", "info", "Cobrança criada na PAY.", String(payment.id), {
          orderId: order.id,
          chargeId: charge.id,
          reference: charge.reference,
          method: parsed.data.paymentMethod,
        });
        res.status(201).json({ payment: publicPayment(updated) });
      } catch (error) {
        store.updatePayment(payment.id, {
          status: "failed",
          failureReason: error instanceof Error ? error.message : "Falha desconhecida",
        });
        store.log("payment.create", "error", "Falha ao criar cobrança.", String(payment.id), {
          error: error instanceof Error ? error.message : error,
        });
        next(error);
      }
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "ID de pagamento inválido." });
      return;
    }
    const payment = store.getPaymentById(id);
    if (!payment) {
      res.status(404).json({ error: "Pagamento não encontrado." });
      return;
    }
    res.json({ payment: publicPayment(payment) });
  });

  return router;
}

export function createChargesRouter(payco: PaycoClient): Router {
  const router = Router();
  router.get("/", async (_req, res, next) => {
    try {
      res.json(await payco.listCharges());
    } catch (error) {
      next(error);
    }
  });
  return router;
}
