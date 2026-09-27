import { Router } from "express";
import { z } from "zod";
import { PaycoClient } from "../payco/client.js";
import { PaymentStore } from "../database/store.js";

const sessionSchema = z.object({
  id: z.string().min(1),
  gid: z.string().min(1),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  currency: z.string().length(3),
  test: z.boolean().optional().default(false),
  customer: z.object({
    email: z.string().email().optional(),
    phone_number: z.string().optional(),
    billing_address: z.object({
      given_name: z.string().optional(),
      family_name: z.string().optional(),
    }).optional(),
  }).optional(),
  payment_method: z.object({
    type: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
});

export function createShopifyPaymentsRouter(store: PaymentStore, payco: PaycoClient): Router {
  const router = Router();

  router.post("/session", async (req, res, next) => {
    try {
      const parsed = sessionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Sessão de pagamento Shopify inválida." });
        return;
      }

      const session = parsed.data;
      const shopDomain = String(req.header("Shopify-Shop-Domain") || "").toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$/.test(shopDomain)) {
        res.status(400).json({ error: "Shopify-Shop-Domain inválido ou ausente." });
        return;
      }

      // PAY.co.mz API charges are denominated in MZN. Do not silently
      // convert USD/ZAR/etc. without an explicit FX policy.
      if (session.currency.toUpperCase() !== "MZN") {
        res.status(422).json({
          error: "A integração PAY.co.mz requer checkout em MZN. Não é seguro converter moedas automaticamente.",
          currency: session.currency,
        });
        return;
      }

      const existing = store.getPaymentByShopifySessionId(session.id);
      if (existing?.checkoutUrl) {
        res.status(200).json({ redirect_url: existing.checkoutUrl });
        return;
      }

      const reserved = store.reserveShopifyPaymentSession(
        session.id,
        session.gid,
        session.amount,
        session.currency,
        shopDomain,
      );

      const customerName = [
        session.customer?.billing_address?.given_name,
        session.customer?.billing_address?.family_name,
      ].filter(Boolean).join(" ") || undefined;

      const customerContact = session.customer?.email || session.customer?.phone_number;
      const method = session.payment_method.type === "offsite" ? "card" : "card";

      const charge = await payco.createCharge({
        amount: session.amount,
        method,
        idempotencyKey: `shopify-payment-session-${session.id}`,
        customer: { name: customerName, email: session.customer?.email, phone: session.customer?.phone_number },
      });

      store.updatePayment(reserved.id, {
        payChargeId: charge.id,
        payReference: charge.reference,
        amountMinor: Math.round(Number(session.amount) * 100),
        currency: session.currency.toUpperCase(),
        paymentMethod: method,
        checkoutUrl: charge.checkoutUrl,
        status: "pending",
        failureReason: null,
      });

      res.status(200).json({ redirect_url: charge.checkoutUrl });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
