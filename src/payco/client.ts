import crypto from "node:crypto";
import { config } from "../config.js";

export interface PayChargeInput {
  amount: string;
  currency: string;
  method: "mpesa" | "mkesh" | "card";
  idempotencyKey: string;
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

/**
 * PAY.co.mz charges are denominated in MZN. Shopify's original amount/currency
 * remain untouched in our payment record; only the amount sent to PAY is converted.
 */
export function convertToPaycoMzn(amount: string, currency: string): string {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new PaycoError("O valor do pagamento deve ser um número positivo.", 400);
  }

  const normalizedCurrency = currency.toUpperCase();
  if (normalizedCurrency === "MZN") return numericAmount.toFixed(2);

  if (normalizedCurrency !== "USD") {
    throw new PaycoError(
      `A PAY.co.mz está configurada para MZN; a moeda ${normalizedCurrency} não tem conversão configurada.`,
      422,
    );
  }

  const rate = config.payco.usdMznRate;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new PaycoError(
      "PAYCO_USD_MZN_RATE não está configurada. Define uma taxa USD/MZN verificada na Render antes de aceitar pagamentos.",
      503,
    );
  }

  return (Math.round(numericAmount * rate * 100) / 100).toFixed(2);
}

export class PaycoClient {
  async createCharge(input: PayChargeInput): Promise<PayCharge> {
    const paycoAmountMzn = convertToPaycoMzn(input.amount, input.currency);

    if (config.payco.mockMode) {
      const id = `mock_${crypto.randomUUID()}`;
      return {
        id,
        reference: input.idempotencyKey,
        checkoutUrl: `${config.appBaseUrl || "http://localhost:5000"}/mock/pay/${encodeURIComponent(input.idempotencyKey)}`,
        status: "pending",
        raw: { mock: true, id, ...input, paycoAmountMzn, paycoCurrency: "MZN" },
      };
    }

    const customerName = input.customer?.name;
    const customerContact = input.method === "card"
      ? input.customer?.email || input.customer?.phone
      : input.customer?.phone;

    if (!customerContact) {
      throw new PaycoError(
        input.method === "card"
          ? "É necessário o e-mail ou telefone do cliente para criar o pagamento por cartão."
          : "É necessário o telefone do cliente para criar o pagamento móvel.",
        400,
      );
    }

    const response = await this.request("/charges", {
      method: "POST",
      headers: {
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        method: input.method,
        amount: Number(paycoAmountMzn),
        customer_name: customerName,
        customer_contact: customerContact,
        wallet_id: config.payco.walletId,
      }),
    });

    const root = asRecord(response);
    const data = asRecord(root.data || root.charge || root);
    const reference =
      firstString(data.reference, data.transaction_reference, data.merchant_reference) || input.idempotencyKey;
    const id =
      firstString(data.id, data.charge_id, data.chargeId, data.transaction_reference, reference) || reference;
    const checkoutUrl = firstString(
      data.checkout_url,
      data.checkoutUrl,
      data.payment_url,
      data.paymentUrl,
      root.checkout_url,
      root.payment_url,
    );

    if (!checkoutUrl) {
      throw new PaycoError("A resposta da PAY não contém checkout_url.", 502, response);
    }

    return {
      id,
      reference,
      checkoutUrl,
      status: firstString(data.status, data.state, root.status) || "pending",
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
          "X-Merchant-Id": config.payco.merchantId,
          "X-Wallet-Id": config.payco.walletId,
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
