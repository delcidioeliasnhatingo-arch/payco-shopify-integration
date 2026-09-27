import crypto from "node:crypto";
import { Router } from "express";
import { config } from "../config.js";
import { PaymentStore } from "../database/store.js";

function validShop(shop: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop);
}

function validHmac(query: Record<string, string | undefined>): boolean {
  if (!config.shopify.apiSecret || !query.hmac) return false;
  const message = Object.keys(query)
    .filter((key) => key !== "hmac" && key !== "signature")
    .sort()
    .map((key) => `${key}=${query[key] ?? ""}`)
    .join("&");
  const expected = crypto.createHmac("sha256", config.shopify.apiSecret).update(message).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(query.hmac, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createShopifyAuthRouter(store: PaymentStore): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const shop = String(req.query.shop || "");
    if (!validShop(shop)) {
      res.status(400).send("Invalid Shopify shop.");
      return;
    }

    const state = crypto.randomBytes(24).toString("hex");
    store.createOAuthState(state, shop.toLowerCase(), new Date(Date.now() + 10 * 60_000).toISOString());

    const params = new URLSearchParams({
      client_id: "ba5997342712bed90c2c0a4e5205eeff",
      scope: config.shopify.oauthScopes,
      redirect_uri: `${config.appBaseUrl}/auth/callback`,
      state,
    });
    res.redirect(`https://${shop}/admin/oauth/authorize?${params.toString()}`);
  });

  router.get("/callback", async (req, res, next) => {
    try {
      const query: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.query)) {
        query[key] = Array.isArray(value) ? String(value[0]) : String(value);
      }

      const shop = query.shop || "";
      const state = query.state || "";
      const code = query.code || "";
      if (!validShop(shop) || !state || !code || !validHmac(query)) {
        res.status(400).send("Invalid Shopify OAuth callback.");
        return;
      }

      const expectedShop = store.consumeOAuthState(state);
      if (expectedShop !== shop.toLowerCase()) {
        res.status(400).send("Invalid OAuth state.");
        return;
      }

      if (!config.shopify.apiSecret) {
        res.status(503).send("SHOPIFY_API_SECRET is not configured.");
        return;
      }

      const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          client_id: "ba5997342712bed90c2c0a4e5205eeff",
          client_secret: config.shopify.apiSecret,
          code,
          redirect_uri: `${config.appBaseUrl}/auth/callback`,
          expiring: "0",
        }),
      });

      const body = await response.json() as { access_token?: string; scope?: string; error?: string };
      if (!response.ok || !body.access_token) {
        res.status(502).send(`Shopify OAuth token exchange failed: ${body.error || "unknown error"}`);
        return;
      }

      store.saveShopifyOAuth(shop.toLowerCase(), body.access_token, body.scope || null);
      res.status(200).send("AVEART PAY.co.mz foi autorizado na Shopify. Pode fechar esta janela.");
    } catch (error) {
      next(error);
    }
  });

  return router;
}
