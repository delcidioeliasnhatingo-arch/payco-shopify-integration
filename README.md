# PAY.co.mz ↔ Shopify

Backend Node.js/TypeScript que cria cobranças na PAY.co.mz para pedidos da Shopify, guarda a relação entre os dois sistemas e processa webhooks assinados.

## Fluxo

1. `POST /api/payments` recebe somente o ID do pedido e o método escolhido.
2. O servidor consulta o pedido diretamente na Shopify e calcula o valor no servidor.
3. O servidor cria a cobrança na PAY e guarda a referência em SQLite.
4. O cliente é redirecionado para o `checkoutUrl`.
5. `POST /webhooks/pay` valida a assinatura, bloqueia eventos antigos e duplicados e, somente depois, registra a transação aprovada na Shopify.

O retorno do navegador não confirma o pagamento. A confirmação confiável é o webhook assinado da PAY.

## Configuração

Copie `.env.example` apenas como referência. No Replit, adicione os valores sensíveis em **Secrets**:

- `PAYCO_API_KEY`
- `PAYCO_WEBHOOK_SECRET`
- `SHOPIFY_ACCESS_TOKEN`

As demais variáveis podem ser configuradas como variáveis de ambiente:

- `PAYCO_API_BASE_URL=https://pay.co.mz/api/public/v1`
- `PAYCO_MERCHANT_ID=8375407039`
- `PAYCO_WALLET_ID=62048`
- `SHOPIFY_STORE_DOMAIN=...myshopify.com`
- `SHOPIFY_API_VERSION=2024-10`
- `APP_BASE_URL=https://seu-projeto.replit.app`

Nunca coloque chaves em código, commits ou mensagens.

## Executar

```bash
npm run dev
```

O servidor escuta em `0.0.0.0:5000`. O banco local é criado em `data/payments.db`.

## Endpoints

### Criar uma cobrança

```bash
curl -X POST "$APP_BASE_URL/api/payments" \
  -H "Content-Type: application/json" \
  -d '{"shopifyOrderId":"123456789","paymentMethod":"mpesa"}'
```

O valor não é aceito no corpo da requisição: ele é consultado na Shopify.

### Consultar o estado local

```bash
curl "$APP_BASE_URL/api/payments/1"
curl "$APP_BASE_URL/health"
curl "$APP_BASE_URL/api/charges"
```

### Webhook PAY

Cadastre na PAY:

```text
https://seu-projeto.replit.app/webhooks/pay
```

O endpoint espera `X-Pay-Signature`, `X-Pay-Event-Id` e, quando fornecido pela PAY, `X-Pay-Timestamp`. A assinatura HMAC-SHA256 é calculada sobre o corpo original. O código aceita os formatos comuns `sha256=<hex>`, `v1=<hex>` e `<hex>`, além da variante `timestamp.corpo`.

## Teste local sem cobrar

Para testar a estrutura sem chamar a PAY, use temporariamente:

```text
PAYCO_MOCK_MODE=true
```

Ainda é necessário configurar a Shopify para criar uma cobrança real a partir de um pedido. Em produção, mantenha `PAYCO_MOCK_MODE=false`.

O primeiro teste de M-Pesa deve ser feito com valor baixo, pois a API de produção da PAY pode não ter sandbox.