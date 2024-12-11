import assert from 'node:assert/strict';
import test from 'node:test';
import { Stripe } from 'stripe';
import { StripePaymentSet } from './stripe-payment-set.js';

const stripeApiKey = process.env.STRIPE_API_KEY;
if (!stripeApiKey) throw new Error('STRIPE_API_KEY is not set');

const stripe = new Stripe(stripeApiKey);

await test('StripePaymentSet', async () => {
  const customer = await stripe.customers.create();

  // 500円の購入を作成
  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customer.id,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'JPY',
        unit_amount: 500,
        product_data: {
          name: 'テストデータ',
        },
      },
    }],
    success_url: 'http://localhost',
    mode: 'payment',
    payment_method_types: ['card'],
    payment_intent_data: {
      capture_method: 'manual',
    },
  });
  const paymentSet = await StripePaymentSet.fromIds(customer.id, checkoutSession.id, []);
  assert.equal(paymentSet.amount, 500);
  assert.equal(paymentSet.amountCapturable, 0);
  assert.equal(paymentSet.amountNet, 0);
  assert.equal(paymentSet.amountRefunded, 0);

  // Checkout Session を完了
  const paymentMethod = await stripe.paymentMethods.create({
    type: 'card',
    card: { token: 'tok_visa' },
    billing_details: { email: 'stripe@example.com' },
  });
  await stripe.paymentMethods.attach(paymentMethod.id, { customer: customer.id });
  await completeStripeCheckoutSession(checkoutSession.id, paymentMethod.id);
  await paymentSet.refetch();
  assert.equal(paymentSet.amount, 500);
  assert.equal(paymentSet.amountCapturable, 500);
  assert.equal(paymentSet.amountNet, 0);
  assert.equal(paymentSet.amountRefunded, 0);

  // キャプチャ可能金額を 400 に変更
  await paymentSet.changeAmountCapturable(400);
  await paymentSet.refetch();
  assert.equal(paymentSet.amount, 400);
  assert.equal(paymentSet.amountCapturable, 400);
  assert.equal(paymentSet.amountNet, 0);
  assert.equal(paymentSet.amountRefunded, 500);

  // キャプチャ可能金額を 600 に変更
  await paymentSet.changeAmountCapturable(600);
  await paymentSet.refetch();
  assert.equal(paymentSet.amount, 600);
  assert.equal(paymentSet.amountCapturable, 600);
  assert.equal(paymentSet.amountNet, 0);
  assert.equal(paymentSet.amountRefunded, 500);

  // キャプチャ
  await paymentSet.capture();
  await paymentSet.refetch();
  assert.equal(paymentSet.amount, 600);
  assert.equal(paymentSet.amountCapturable, 0);
  assert.equal(paymentSet.amountNet, 600);
  assert.equal(paymentSet.amountRefunded, 500);

  // 金額を500に変更
  await paymentSet.changeAmountNet(500);
  await paymentSet.refetch();
  assert.equal(paymentSet.amount, 500);
  assert.equal(paymentSet.amountCapturable, 0);
  assert.equal(paymentSet.amountNet, 500);
  assert.equal(paymentSet.amountRefunded, 600);

  // 金額を700に変更
  await paymentSet.changeAmountNet(700);
  await paymentSet.refetch();
  assert.equal(paymentSet.amount, 700);
  assert.equal(paymentSet.amountCapturable, 0);
  assert.equal(paymentSet.amountNet, 700);
  assert.equal(paymentSet.amountRefunded, 600);
});

async function completeStripeCheckoutSession(checkoutSessionId: string, paymentMethodId: string) {
  const resp = await fetch(`https://api.stripe.com/v1/payment_pages/${checkoutSessionId}/confirm`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${stripeApiKey}`,
      'user-agent': 'Stripe/v1 stripe-cli/master',
    },
    body: new URLSearchParams({
      payment_method: paymentMethodId,
    }),
  });
  if (resp.status < 200 || resp.status >= 300) throw new Error(`failed to complete checkout session: ${resp.status}: ${await resp.text()}`);
  return resp.json();
}
