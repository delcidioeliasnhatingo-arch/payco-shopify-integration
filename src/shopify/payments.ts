import { config } from "../config.js";
import { PaymentStore } from "../database/store.js";

export class ShopifyPaymentsError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = "ShopifyPaymentsError";
    this.statusCode = statusCode;
  }
}

type PaymentMutation = "resolve" | "reject";

export class ShopifyPaymentsClient {
  constructor(private readonly store: PaymentStore) {}
  private async graphql<T>(query: string, variables: Record<string, unknown>, shopDomain?: string): Promise<T> {
    const domain = shopDomain || config.shopify.storeDomain;
    const accessToken = shopDomain ? this.store.getShopifyAccessToken(shopDomain) : config.shopify.paymentsAccessToken;
    if (!domain || !accessToken) {
      throw new ShopifyPaymentsError(
        "SHOPIFY_STORE_DOMAIN e SHOPIFY_PAYMENTS_ACCESS_TOKEN precisam estar configurados.",
        503,
      );
    }

    const response = await fetch(
      `https://${domain}/payments_apps/api/${config.shopify.paymentsApiVersion}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
      },
    );

    const text = await response.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new ShopifyPaymentsError("Resposta inválida da Shopify Payments Apps API.", response.status || 502);
    }

    if (!response.ok || body.errors?.length) {
      throw new ShopifyPaymentsError(
        `Shopify Payments Apps API respondeu HTTP ${response.status}: ${JSON.stringify(body.errors || body).slice(0, 1000)}`,
        response.status || 502,
      );
    }

    return body.data as T;
  }

  async resolvePaymentSession(id: string, networkTransactionId: string, shopDomain?: string): Promise<void> {
    const query = `mutation Resolve($id: ID!, $networkTransactionId: String) {
      paymentSessionResolve(
        id: $id
        networkTransactionId: $networkTransactionId
      ) {
        paymentSession { id state { ... on PaymentSessionStateResolved { code } } }
        userErrors { field message }
      }
    }`;
    const data: any = await this.graphql(query, { id, networkTransactionId }, shopDomain);
    const errors = data.paymentSessionResolve?.userErrors || [];
    if (errors.length) throw new ShopifyPaymentsError(errors.map((e: any) => e.message).join("; "), 502);
  }

  async rejectPaymentSession(id: string, message: string, shopDomain?: string): Promise<void> {
    const query = `mutation Reject($id: ID!, $reason: PaymentSessionRejectionReasonInput!) {
      paymentSessionReject(id: $id, reason: $reason) {
        paymentSession { id }
        userErrors { field message }
      }
    }`;
    const data: any = await this.graphql(query, {
      id,
      reason: { code: "PROCESSING_ERROR", merchantMessage: message.slice(0, 500), source: "NETWORK" },
    }, shopDomain);
    const errors = data.paymentSessionReject?.userErrors || [];
    if (errors.length) throw new ShopifyPaymentsError(errors.map((e: any) => e.message).join("; "), 502);
  }
}
