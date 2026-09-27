import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type PaymentStatus = "creating" | "pending" | "succeeded" | "failed";

export interface PaymentRecord {
  id: number;
  shopifyOrderId: string;
  shopifyOrderGid: string | null;
  shopifyPaymentSessionId: string | null;
  shopifyPaymentSessionGid: string | null;
  shopifyShopDomain: string | null;
  payChargeId: string | null;
  payReference: string | null;
  amountMinor: number;
  currency: string | null;
  paymentMethod: string | null;
  checkoutUrl: string | null;
  status: PaymentStatus;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface PaymentRow {
  id: number;
  shopify_order_id: string;
  shopify_order_gid: string | null;
  shopify_payment_session_id: string | null;
  shopify_payment_session_gid: string | null;
  shopify_shop_domain: string | null;
  pay_charge_id: string | null;
  pay_reference: string | null;
  amount_minor: number;
  currency: string | null;
  payment_method: string | null;
  checkout_url: string | null;
  status: PaymentStatus;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function mapPayment(row: PaymentRow | undefined): PaymentRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    shopifyOrderId: row.shopify_order_id,
    shopifyOrderGid: row.shopify_order_gid,
    shopifyPaymentSessionId: row.shopify_payment_session_id,
    shopifyPaymentSessionGid: row.shopify_payment_session_gid,
    shopifyShopDomain: row.shopify_shop_domain,
    payChargeId: row.pay_charge_id,
    payReference: row.pay_reference,
    amountMinor: row.amount_minor,
    currency: row.currency,
    paymentMethod: row.payment_method,
    checkoutUrl: row.checkout_url,
    status: row.status,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export class PaymentStore {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shopify_order_id TEXT NOT NULL UNIQUE,
        shopify_order_gid TEXT,
        shopify_payment_session_id TEXT UNIQUE,
        shopify_payment_session_gid TEXT,
        shopify_shop_domain TEXT,
        pay_charge_id TEXT UNIQUE,
        pay_reference TEXT UNIQUE,
        amount_minor INTEGER NOT NULL DEFAULT 0,
        currency TEXT,
        payment_method TEXT,
        checkout_url TEXT,
        status TEXT NOT NULL CHECK (status IN ('creating', 'pending', 'succeeded', 'failed')),
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS webhook_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT,
        status TEXT NOT NULL CHECK (status IN ('processing', 'processed', 'failed')),
        received_at TEXT NOT NULL,
        processed_at TEXT,
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS shopify_oauth (
        shop_domain TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        scope TEXT,
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        shop_domain TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS operation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        entity_id TEXT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("payments", "shopify_payment_session_id", "TEXT");
    this.ensureColumn("payments", "shopify_payment_session_gid", "TEXT");
    this.ensureColumn("payments", "shopify_shop_domain", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  getPaymentById(id: number): PaymentRecord | null {
    return mapPayment(this.db.prepare("SELECT * FROM payments WHERE id = ?").get(id) as PaymentRow | undefined);
  }

  getPaymentByShopifySessionId(sessionId: string): PaymentRecord | null {
    return mapPayment(
      this.db.prepare("SELECT * FROM payments WHERE shopify_payment_session_id = ?").get(sessionId) as PaymentRow | undefined,
    );
  }

  getPaymentByShopifyOrderId(orderId: string): PaymentRecord | null {
    return mapPayment(
      this.db.prepare("SELECT * FROM payments WHERE shopify_order_id = ?").get(orderId) as PaymentRow | undefined,
    );
  }

  getPaymentByPayChargeId(chargeId: string): PaymentRecord | null {
    return mapPayment(
      this.db.prepare("SELECT * FROM payments WHERE pay_charge_id = ?").get(chargeId) as PaymentRow | undefined,
    );
  }

  getPaymentByPayReference(reference: string): PaymentRecord | null {
    return mapPayment(
      this.db.prepare("SELECT * FROM payments WHERE pay_reference = ?").get(reference) as PaymentRow | undefined,
    );
  }

  reservePayment(orderId: string, orderGid: string | null, paymentMethod: string): {
    created: boolean;
    payment: PaymentRecord;
  } {
    const now = new Date().toISOString();
    const reserve = this.db.transaction(() => {
      const existing = this.getPaymentByShopifyOrderId(orderId);
      if (existing) return { created: false, payment: existing };

      this.db
        .prepare(`
          INSERT INTO payments
            (shopify_order_id, shopify_order_gid, payment_method, status, created_at, updated_at)
          VALUES (?, ?, ?, 'creating', ?, ?)
        `)
        .run(orderId, orderGid, paymentMethod, now, now);

      return {
        created: true,
        payment: this.getPaymentByShopifyOrderId(orderId)!,
      };
    });

    return reserve();
  }

  getShopifyAccessToken(shopDomain: string): string | null {
    const row = this.db.prepare("SELECT access_token FROM shopify_oauth WHERE shop_domain = ?").get(shopDomain) as { access_token: string } | undefined;
    return row?.access_token || null;
  }

  saveShopifyOAuth(shopDomain: string, accessToken: string, scope: string | null): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO shopify_oauth (shop_domain, access_token, scope, installed_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(shop_domain) DO UPDATE SET access_token=excluded.access_token, scope=excluded.scope, updated_at=excluded.updated_at`).run(shopDomain, accessToken, scope, now, now);
  }

  createOAuthState(state: string, shopDomain: string, expiresAt: string): void {
    this.db.prepare("INSERT INTO oauth_states (state, shop_domain, expires_at) VALUES (?, ?, ?)").run(state, shopDomain, expiresAt);
  }

  consumeOAuthState(state: string): string | null {
    const row = this.db.prepare("SELECT shop_domain, expires_at FROM oauth_states WHERE state = ?").get(state) as { shop_domain: string; expires_at: string } | undefined;
    this.db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
    if (!row || new Date(row.expires_at).getTime() < Date.now()) return null;
    return row.shop_domain;
  }

  reserveShopifyPaymentSession(sessionId: string, sessionGid: string, amount: string, currency: string, shopDomain?: string): PaymentRecord {
    const existing = this.getPaymentByShopifySessionId(sessionId);
    if (existing) return existing;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO payments
        (shopify_order_id, shopify_order_gid, shopify_payment_session_id, shopify_payment_session_gid, shopify_shop_domain, amount_minor, currency, payment_method, status, created_at, updated_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?, 'card', 'creating', ?, ?)
    `).run(`payment-session:${sessionId}`, sessionId, sessionGid, shopDomain || null, Math.round(Number(amount) * 100), currency.toUpperCase(), now, now);
    return this.getPaymentByShopifySessionId(sessionId)!;
  }

  updatePayment(
    id: number,
    values: Partial<{
      payChargeId: string | null;
      payReference: string | null;
      shopifyOrderGid: string | null;
      shopifyPaymentSessionId: string | null;
      shopifyPaymentSessionGid: string | null;
      amountMinor: number;
      currency: string | null;
      paymentMethod: string | null;
      checkoutUrl: string | null;
      status: PaymentStatus;
      failureReason: string | null;
      completedAt: string | null;
    }>,
  ): PaymentRecord {
    const columns: string[] = [];
    const params: unknown[] = [];
    const fieldMap: Record<string, string> = {
      payChargeId: "pay_charge_id",
      payReference: "pay_reference",
      shopifyOrderGid: "shopify_order_gid",
      shopifyPaymentSessionId: "shopify_payment_session_id",
      shopifyPaymentSessionGid: "shopify_payment_session_gid",
      shopifyShopDomain: "shopify_shop_domain",
      amountMinor: "amount_minor",
      currency: "currency",
      paymentMethod: "payment_method",
      checkoutUrl: "checkout_url",
      status: "status",
      failureReason: "failure_reason",
      completedAt: "completed_at",
    };

    for (const [key, value] of Object.entries(values)) {
      const column = fieldMap[key];
      if (column) {
        columns.push(`${column} = ?`);
        params.push(value);
      }
    }

    columns.push("updated_at = ?");
    params.push(new Date().toISOString(), id);
    this.db.prepare(`UPDATE payments SET ${columns.join(", ")} WHERE id = ?`).run(...params);
    return this.getPaymentById(id)!;
  }

  claimWebhookEvent(eventId: string, eventType: string): { isNew: boolean; status: string } {
    const now = new Date().toISOString();
    const inserted = this.db
      .prepare(`
        INSERT OR IGNORE INTO webhook_events (event_id, event_type, status, received_at)
        VALUES (?, ?, 'processing', ?)
      `)
      .run(eventId, eventType, now);

    if (inserted.changes === 1) return { isNew: true, status: "processing" };
    const existing = this.db.prepare("SELECT status FROM webhook_events WHERE event_id = ?").get(eventId) as
      | { status: string }
      | undefined;
    return { isNew: false, status: existing?.status || "unknown" };
  }

  completeWebhookEvent(eventId: string): void {
    this.db
      .prepare("UPDATE webhook_events SET status = 'processed', processed_at = ?, error_message = NULL WHERE event_id = ?")
      .run(new Date().toISOString(), eventId);
  }

  failWebhookEvent(eventId: string, message: string): void {
    this.db
      .prepare("UPDATE webhook_events SET status = 'failed', error_message = ? WHERE event_id = ?")
      .run(message.slice(0, 1000), eventId);
  }

  log(operation: string, level: "info" | "warn" | "error", message: string, entityId?: string, metadata?: unknown): void {
    this.db
      .prepare(`
        INSERT INTO operation_logs (operation, entity_id, level, message, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(operation, entityId || null, level, message, metadata ? JSON.stringify(metadata) : null, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}