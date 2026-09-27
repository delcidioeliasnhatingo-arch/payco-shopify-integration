import express from "express";
import { config } from "./config.js";
import { PaymentStore } from "./database/store.js";
import { PaycoClient } from "./payco/client.js";
import { createChargesRouter, createPaymentsRouter } from "./routes/payments.js";
import { createWebhooksRouter } from "./routes/webhooks.js";
import { createShopifyPaymentsRouter } from "./routes/shopifyPayments.js";
import { ShopifyPaymentsClient } from "./shopify/payments.js";
import { ShopifyClient } from "./shopify/client.js";
import { createShopifyComplianceRouter } from "./routes/shopifyCompliance.js";
import { createShopifyAuthRouter } from "./routes/shopifyAuth.js";

const store = new PaymentStore(config.databasePath);
const payco = new PaycoClient();
const shopify = new ShopifyClient();
const shopifyPayments = new ShopifyPaymentsClient(store);
const app = express();

app.disable("x-powered-by");
app.use("/webhooks", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json({ limit: "100kb" }));

app.get("/", (_req, res) => {
  res.json({
    service: "PAY.co.mz Shopify integration",
    status: "ok",
    endpoints: {
      health: "/health",
      createPayment: "POST /api/payments",
      payment: "GET /api/payments/:id",
      charges: "GET /api/charges",
      payWebhook: "POST /webhooks/pay",
      shopifyPaymentSession: "POST /payments/shopify/session",
    },
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "payco-shopify-integration",
    environment: process.env.NODE_ENV || "development",
    configuration: {
      paycoApiKey: Boolean(config.payco.apiKey),
      paycoWebhookSecret: Boolean(config.payco.webhookSecret),
      shopifyAccessToken: Boolean(config.shopify.accessToken),
      shopifyStoreDomain: Boolean(config.shopify.storeDomain),
      shopifyPaymentsAccessToken: Boolean(config.shopify.paymentsAccessToken),
      paycoMockMode: config.payco.mockMode,
    },
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/payments", createPaymentsRouter(store, payco, shopify));
app.use("/api/charges", createChargesRouter(payco));
app.use("/payments/shopify", createShopifyPaymentsRouter(store, payco));
app.use("/auth", createShopifyAuthRouter(store));
app.use("/webhooks/shopify-compliance", createShopifyComplianceRouter());
app.use("/webhooks", createWebhooksRouter(store, shopify, shopifyPayments));

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const statusCode =
    typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
  const message = error instanceof Error ? error.message : "Erro interno.";
  res.status(statusCode).json({ error: message });
});

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`PAY/Shopify backend listening on 0.0.0.0:${config.port}`);
  console.log(`Database: ${config.databasePath}`);
});

function shutdown(signal: string) {
  console.log(`${signal} received; shutting down.`);
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));