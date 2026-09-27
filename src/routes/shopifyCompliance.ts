import crypto from "node:crypto";
import { Router } from "express";
import { config } from "../config.js";

function validHmac(rawBody: Buffer, header: string | undefined): boolean {
  if (!config.shopify.appHmacKey || !header) return false;
  const expected = crypto.createHmac("sha256", config.shopify.appHmacKey).update(rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(header.trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createShopifyComplianceRouter(): Router {
  const router = Router();

  router.post("/", (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    if (!validHmac(rawBody, req.header("X-Shopify-Hmac-Sha256"))) {
      res.status(401).send("Unauthorized");
      return;
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      res.status(400).send("Invalid JSON");
      return;
    }

    console.log("Shopify compliance webhook received", {
      topic: req.header("X-Shopify-Topic"),
      shop: req.header("X-Shopify-Shop-Domain"),
      payloadKeys: Object.keys(payload),
    });

    res.status(200).send("OK");
  });

  return router;
}
