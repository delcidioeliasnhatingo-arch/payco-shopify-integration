import crypto from "node:crypto";
import { config } from "../config.js";

export interface PayChargeInput {
  amount: string;
  currency: string;
  method: string;
  reference: string;
  description: string;
  returnUrl: string;
  callbackUrl: string;
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
  };
}

export interface PayCharge {
  id: string;
  reference: string;
  checkoutUrl: string;
  status: string;
  raw: unknown;
}

export class PaycoError extends Error {
  statusCode: number;
  responseBody: unknown;

  constructor(message: string, statusCode = 502, responseBody?: unknown) {
    super(message);
    this.name = "PaycoError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

export class PaycoClient {
  async createCharge(input: PayChargeInput): Promise<PayCharge> {
    if (config.payco.mockMode) {
      const id = `mock_${crypto.randomUUID()}`;
      return {
        id,
        reference: input.reference,
        checkoutUrl: `${config.appBaseUrl || "http://localhost:5000"}/mock/pay/${encodeURIComponent(input.reference)}`,
        status: "pending",
        raw: { mock: true, id, ...input },
      };
    }

    const response = await this.request("/charges", {
      method: "POST",
      body: JSON.stringify({
        merchant_id: config.payco.merchantId,
        wallet_id: config.payco.walletId,
        amount: input.amount,
        currency: input.currency,
        method: input.method,
        reference: input.reference,
        description: input.description,
        return_url: input.returnUrl,
        callback_url: input.callbackUrl,
        customer: input.customer,
      }),
    });

    const root = asRecord(response);
    const data = asRecord(root.data || root.charge || root);
    const id = firstString(data.id, data.charge_id, data.chargeId, root.id, root.charge_id);
    const reference = firstString(data.reference, data.merchant_reference, input.reference) || input.reference;
    const checkoutUrl = firstString(
      data.checkout_url,
      data.checkoutUrl,
      data.payment_url,
      data.paymentUrl,
      root.checkout_url,
      root.payment_url,
    );

    if (!id || !checkoutUrl) {
      throw new PaycoError("A resposta da PAY não contém id ou checkout_url.", 502, response);
    }

    return {
      id,
      reference,
      checkoutUrl,
      status: firstString(data.status, root.status) || "pending",
      raw: response,
    };
  }

  async listCharges(): Promise<unknown> {
    if (config.payco.mockMode) return { data: [], mock: true };
    return this.request("/charges", { method: "GET" });
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    if (!config.payco.apiKey) {
      throw new PaycoError("PAYCO_API_KEY não está configurada.", 503);
    }

    let response: Response;
    try {
      response = await fetch(`${config.payco.apiBaseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.payco.apiKey}`,
          "X-API-Key": config.payco.apiKey,
          ...(init.headers || {}),
        },
      });
    } catch (error) {
      throw new PaycoError(`Não foi possível conectar à PAY: ${error instanceof Error ? error.message : "erro desconhecido"}`);
    }

    const text = await response.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }

    if (!response.ok) {
      throw new PaycoError(`A PAY respondeu HTTP ${response.status}.`, response.status, body);
    }
    return body;
  }
}