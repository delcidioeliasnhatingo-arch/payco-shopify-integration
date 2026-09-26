import { config } from "../config.js";

export interface ShopifyOrder {
  id: string;
  gid: string;
  amount: string;
  currency: string;
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
  };
  raw: unknown;
}

export class ShopifyError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = "ShopifyError";
    this.statusCode = statusCode;
  }
}

function normalizeOrderId(value: string): string {
  const match = value.match(/\/(\d+)$/);
  if (match) return match[1];
  if (/^\d+$/.test(value)) return value;
  throw new ShopifyError("shopifyOrderId deve ser um ID numérico ou um GID terminando em ID numérico.", 400);
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

export class ShopifyClient {
  async getOrder(orderId: string): Promise<ShopifyOrder> {
    const numericId = normalizeOrderId(orderId);
    const body = await this.request(`/admin/api/${config.shopify.apiVersion}/orders/${numericId}.json?fields=id,current_total_price,total_price,currency,customer`, {
      method: "GET",
    });
    const order = asRecord(asRecord(body).order);
    const amount = order.current_total_price || order.total_price;
    if (!order.id || !amount || !order.currency) {
      throw new ShopifyError("A Shopify não retornou id, valor ou moeda para o pedido.", 502);
    }

    const customer = asRecord(order.customer);
    return {
      id: String(order.id),
      gid: `gid://shopify/Order/${order.id}`,
      amount: String(amount),
      currency: String(order.currency),
      customer: {
        name: [customer.first_name, customer.last_name].filter(Boolean).join(" ") || undefined,
        email: typeof customer.email === "string" ? customer.email : undefined,
        phone: typeof customer.phone === "string" ? customer.phone : undefined,
      },
      raw: body,
    };
  }

  async markOrderPaid(orderId: string, amount: string, currency: string, payChargeId: string): Promise<unknown> {
    const numericId = normalizeOrderId(orderId);
    return this.request(`/admin/api/${config.shopify.apiVersion}/orders/${numericId}/transactions.json`, {
      method: "POST",
      body: JSON.stringify({
        transaction: {
          kind: "sale",
          status: "success",
          amount,
          currency,
          gateway: "PAY.co.mz",
          authorization: payChargeId,
        },
      }),
    });
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    if (!config.shopify.storeDomain || !config.shopify.accessToken) {
      throw new ShopifyError("SHOPIFY_STORE_DOMAIN e SHOPIFY_ACCESS_TOKEN não estão configurados.", 503);
    }

    let response: Response;
    try {
      response = await fetch(`https://${config.shopify.storeDomain}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": config.shopify.accessToken,
          ...(init.headers || {}),
        },
      });
    } catch (error) {
      throw new ShopifyError(`Não foi possível conectar à Shopify: ${error instanceof Error ? error.message : "erro desconhecido"}`);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new ShopifyError(`A Shopify respondeu HTTP ${response.status}: ${text.slice(0, 500)}`, response.status);
    }

    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { raw: text };
    }
  }
}