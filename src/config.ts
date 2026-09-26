import path from "node:path";

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function booleanFromEnv(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function cleanDomain(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export const config = {
  port: numberFromEnv("PORT", 5000),
  appBaseUrl: (process.env.APP_BASE_URL || "").replace(/\/+$/, ""),
  databasePath: path.resolve(process.env.DATABASE_PATH || "./data/payments.db"),
  webhookToleranceSeconds: numberFromEnv("WEBHOOK_TOLERANCE_SECONDS", 300),
  payco: {
    apiBaseUrl: (process.env.PAYCO_API_BASE_URL || "https://pay.co.mz/api/public/v1").replace(/\/+$/, ""),
    apiKey: process.env.PAYCO_API_KEY,
    webhookSecret: process.env.PAYCO_WEBHOOK_SECRET,
    merchantId: process.env.PAYCO_MERCHANT_ID || "8375407039",
    walletId: process.env.PAYCO_WALLET_ID || "62048",
    mockMode: booleanFromEnv("PAYCO_MOCK_MODE"),
  },
  shopify: {
    storeDomain: cleanDomain(process.env.SHOPIFY_STORE_DOMAIN),
    apiVersion: process.env.SHOPIFY_API_VERSION || "2024-10",
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
  },
};

export function hasPaycoCredentials(): boolean {
  return Boolean(config.payco.apiKey);
}

export function hasWebhookSecret(): boolean {
  return Boolean(config.payco.webhookSecret);
}

export function hasShopifyCredentials(): boolean {
  return Boolean(config.shopify.storeDomain && config.shopify.accessToken);
}