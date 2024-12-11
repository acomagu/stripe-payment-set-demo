import util from 'node:util';
import { Stripe } from 'stripe';

const stripeApiKey = process.env.STRIPE_API_KEY;
if (!stripeApiKey) throw new Error('STRIPE_API_KEY is not set');

const stripe = new Stripe(stripeApiKey, {
  apiVersion: '2024-11-20.acacia',
});

// Stripe側の用語
//
// Stripe Checkout:
// - AmountTotal: 最初に設定(意図)された金額
//
// Stripe PaymentIntent:
// - Amount: 最初に設定(意図)された金額
// - AmountReceived: キャプチャされた金額(返金額含む)
// - AmountCapturable: キャプチャ可能な金額
//
// Stripe Chrage:
// - Amount: 最初に設定(意図)された金額
// - AmountCaptured: キャプチャされた金額(返金額含む)
// - AmountRefunded: 返金された金額(未キャプチャでキャンセルされた金額含む)

export class StripePaymentSet {
  constructor(
    readonly stripeCustomerId: string,
    public stripeCheckoutSession: Stripe.Checkout.Session & { payment_intent: { latest_charge: object } | null },
    public stripePaymentIntents: (Stripe.PaymentIntent & { latest_charge: object })[],
  ) { }
  static async fromIds(stripeCustomerId: string, stripeCheckoutSessionId: string, stripePaymentIntentIds: string[]) {
    const { stripeCheckoutSession, stripePaymentIntents } = await StripePaymentSet.fetchFromIds(stripeCheckoutSessionId, stripePaymentIntentIds);
    return new StripePaymentSet(stripeCustomerId, stripeCheckoutSession, stripePaymentIntents);
  }
  async refetch() {
    const stripePaymentIntentIds = this.stripePaymentIntents.map(pi => pi.id);
    const { stripeCheckoutSession, stripePaymentIntents } = await StripePaymentSet.fetchFromIds(this.stripeCheckoutSession.id, stripePaymentIntentIds);
    this.stripeCheckoutSession = stripeCheckoutSession;
    this.stripePaymentIntents = stripePaymentIntents;
  }
  private static async fetchFromIds(stripeCheckoutSessionId: string, stripePaymentIntentIds: string[]) {
    const [stripeCheckoutSession, ...stripePaymentIntents] = await Promise.all([
      stripe.checkout.sessions.retrieve(stripeCheckoutSessionId, {
        expand: ['payment_intent', 'payment_intent.latest_charge'],
      }),
      ...stripePaymentIntentIds.map(paymentIntentId =>
        stripe.paymentIntents.retrieve(paymentIntentId, {
          expand: ['latest_charge'],
        }),
      ),
    ]);
    return {
      stripeCheckoutSession: assertPaymentIntentLatestChargeExpanded(stripeCheckoutSession),
      stripePaymentIntents: stripePaymentIntents.map(assertLatestChargeExpanded),
    };
  }
  get amountCapturable() {
    return this.stripePaymentIntentsIncludesCheckoutSessions.reduce((sum, paymentIntent) =>
      sum + paymentIntent.amount_capturable,
      0,
    );
  }
  // 現状の予定された金額(キャプチャもオーソリもされていない金額も含む)
  get amount() {
    // まだ Payment Intent が発行されていない場合
    if (!this.stripeCheckoutSession.payment_intent) {
      return this.stripeCheckoutSession.amount_total ?? 0;
    }

    // 既に Payment Intent が発行されている場合
    return this.stripePaymentIntentsIncludesCheckoutSessions.reduce(
      (sum, paymentIntent) => sum + paymentIntent.amount,
      0,
    ) - this.amountRefunded;
  }
  // キャプチャ済みの金額(返金額含まない)
  get amountNet() {
    return this.stripePaymentIntentsIncludesCheckoutSessions.map(paymentIntent => {
      const charge = latestChargeOfPaymentIntent(paymentIntent);
      return charge?.captured ? charge.amount - charge.amount_refunded : 0;
    }).reduce((a, b) => a + b, 0);
  }
  // 返金済み金額
  get amountRefunded() {
    return this.stripePaymentIntentsIncludesCheckoutSessions.map(paymentIntent =>
      latestChargeOfPaymentIntent(paymentIntent)?.amount_refunded ?? 0,
    ).reduce((a, b) => a + b, 0);
  }
  // オーソリ金額を変更する
  async changeAmountCapturable(amount: number) {
    const paymentIntents = [...this.stripePaymentIntentsIncludesCheckoutSessions];
    const currentAmount = this.amountCapturable;
    const diff = currentAmount - amount;
    if (diff === 0) return;

    // paymentIntentsSorted sorted by priority to cancel/refund.
    const paymentIntentsSorted = paymentIntents
      .filter((paymentIntent): paymentIntent is typeof paymentIntent & { status: 'requires_capture' } =>
        paymentIntent.status === 'requires_capture',
      ).sort((a, b) => a.amount - b.amount);

    let diffRemains = diff;
    while (diffRemains > 0) {
      const paymentIntent = paymentIntentsSorted.pop();
      if (!paymentIntent) throw new Error(`Logic Error: can't find the payment intent to cancel; diff: ${diff}; paymentIntents: ${util.format(paymentIntents)}; paymentIntentsSorted: ${util.format(paymentIntentsSorted)}`);

      await stripe.paymentIntents.cancel(paymentIntent.id);
      console.log(`Payment intent is canceled; stripePaymentIntentId: ${paymentIntent.id}`);

      diffRemains -= paymentIntent.amount_capturable;
    }
    if (diffRemains < 0) {
      let paymentMethodId = paymentIntents.find(pi => pi.payment_method)?.payment_method;
      if (!paymentMethodId) throw new Error(`These payment intents has no payment methods: ${this.stripePaymentIntentsIncludesCheckoutSessions.map(pi => pi.id)}`);
      if (typeof paymentMethodId === 'object') paymentMethodId = paymentMethodId.id;

      const paymentIntent = await stripe.paymentIntents.create({
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'never',
        },
        amount: -diffRemains,
        capture_method: 'manual',
        confirm: true,
        currency: 'JPY',
        customer: this.stripeCustomerId,
        expand: ['latest_charge'],
        payment_method: paymentMethodId,
      });
      console.log(`New payment intent is created; stripePaymentIntentId: ${paymentIntent.id}`);
      this.stripePaymentIntents.push(assertLatestChargeExpanded(paymentIntent));
      return paymentIntent.id;
    }
    return undefined;
  }
  // キャプチャ済みの金額を変更する
  async changeAmountNet(amount: number) {
    const paymentIntents = [...this.stripePaymentIntentsIncludesCheckoutSessions];
    const currentAmount = this.amountNet;
    const diff = currentAmount - amount;
    if (diff === 0) return;

    // paymentIntentsSorted sorted by priority to cancel/refund.
    const paymentIntentsSorted = paymentIntents
      .filter((paymentIntent): paymentIntent is typeof paymentIntent & { status: 'succeeded' } =>
        paymentIntent.status === 'succeeded',
      ).sort((a, b) => a.amount - b.amount);

    let diffRemains = diff;
    while (diffRemains > 0) {
      const paymentIntent = paymentIntentsSorted.pop();
      if (!paymentIntent) throw new Error(`Logic Error: can't find the payment intent to cancel; diff: ${diff}; paymentIntents: ${util.format(paymentIntents)}; paymentIntentsSorted: ${util.format(paymentIntentsSorted)}`);

      const refundableAmount = paymentIntent.amount_received - (latestChargeOfPaymentIntent(paymentIntent)?.amount_refunded ?? 0);
      const refundAmount = Math.min(diffRemains, refundableAmount);
      if (refundAmount <= 0) continue;

      let refund = await stripe.refunds.create({
        payment_intent: paymentIntent.id,
        amount: refundAmount,
      });

      // Wait for the refunding is complete.
      for (let waitTime = 100; refund.status === 'pending'; waitTime *= 2) {
        refund = await stripe.refunds.retrieve(refund.id);
        await new Promise(r => setTimeout(r, waitTime));
      }

      if (refund.status !== 'succeeded') {
        throw new Error(`Failed to refund: id: ${refund.id}, failure_reason: ${refund.failure_reason}`);
      }
      console.log(`Refund created; stripePaymentIntentId: ${paymentIntent.id}, amount: ${refundAmount}`);

      diffRemains -= refundAmount;
    }
    if (diffRemains < 0) {
      let paymentMethodId = paymentIntents.find(pi => pi.payment_method)?.payment_method;
      if (!paymentMethodId) throw new Error(`These payment intents has no payment methods: ${this.stripePaymentIntentsIncludesCheckoutSessions.map(pi => pi.id)}`);
      if (typeof paymentMethodId === 'object') paymentMethodId = paymentMethodId.id;

      const paymentIntent = await stripe.paymentIntents.create({
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'never',
        },
        amount: -diffRemains,
        capture_method: 'automatic',
        confirm: true,
        currency: 'JPY',
        customer: this.stripeCustomerId,
        expand: ['latest_charge'],
        payment_method: paymentMethodId,
      });
      console.log(`New payment intent is created; stripePaymentIntentId: ${paymentIntent.id}`);
      this.stripePaymentIntents.push(assertLatestChargeExpanded(paymentIntent));
      return paymentIntent.id;
    }
    return undefined;
  }
  async capture(amount?: number, cancelRemainingAuthorization: boolean = true) {
    const paymentIntents = this.stripePaymentIntentsIncludesCheckoutSessions;
    const amountCapturable = this.amountCapturable
    if (amount !== undefined) {
      if (amount === 0) return;
      if (amount < 0) throw new Error(`Negative amount is specified: ${amount}`);
      if (amount > amountCapturable) throw new Error(`Specified amount is bigger than amountCapturable. amount: ${amount} amountCapturable: ${amountCapturable}`);
    } else {
      amount = amountCapturable;
    }

    // paymentIntentsSorted sorted by priority to capture.
    const paymentIntentsSorted = paymentIntents
      .filter((paymentIntent): paymentIntent is typeof paymentIntent & { status: 'requires_capture' } =>
        paymentIntent.status === 'requires_capture',
      ).sort((a, b) => a.amount - b.amount);

    let amountRemains = amount;
    while (amountRemains) {
      const paymentIntent = paymentIntentsSorted.pop()
      if (!paymentIntent) throw new Error(`Logic Error: can't find the payment intent to capture; amount: ${amount}; paymentIntents: ${util.format(paymentIntents)}; paymentIntentsSorted: ${util.format(paymentIntentsSorted)}`);

      const amount_to_capture = Math.min(paymentIntent.amount_capturable, amountRemains);
      const { status } = await stripe.paymentIntents.capture(paymentIntent.id, { amount_to_capture });
      console.log(`Payment intent is captured; stripePaymentIntentId: ${paymentIntent.id}, amount: ${amount_to_capture}`);

      // According to the document, status can be 'succeeded' or erroneous one.
      if (status !== 'succeeded') {
        console.error(`The payment intent can't be capture. paymentIntentId: ${paymentIntent.id}`);
        continue;
      }

      amountRemains -= amount_to_capture;
    }

    if (cancelRemainingAuthorization) {
      const results = await Promise.allSettled(paymentIntentsSorted.map(async paymentIntent => {
        if (paymentIntent.status !== 'requires_capture') return; // "succeeded" PaymentIntent can't be canceled even if it has amount_capturable.
        await stripe.paymentIntents.cancel(paymentIntent.id, {
          cancellation_reason: 'abandoned',
        });
        console.log(`Payment intent is canceled; stripePaymentIntentId: ${paymentIntent.id}`);
      }));
      const errors = results.flatMap(result => result.status === 'fulfilled' ? [] : result.reason);
      if (errors.length) throw new AggregateError(errors);
    }
  }
  async changeAmounts(amountCapturable: number, amountNet: number) {
    const capturableAmountDiff = amountCapturable - this.amountCapturable;
    const netAmountDiff = amountNet - this.amountNet;
    if (netAmountDiff > 0 && capturableAmountDiff < 0) {
      await this.capture(Math.min(netAmountDiff, -capturableAmountDiff), false);
    }
    await this.changeAmountCapturable(amountCapturable);
    await this.changeAmountNet(amountNet);
  }
  private get stripePaymentIntentsIncludesCheckoutSessions() {
    if (!this.stripeCheckoutSession.payment_intent) return this.stripePaymentIntents;
    if (typeof this.stripeCheckoutSession.payment_intent !== 'object') throw new Error('stripeCheckoutSession.payment_intent seems not to be expanded');
    return [this.stripeCheckoutSession.payment_intent, ...this.stripePaymentIntents];
  }
}

function assertPaymentIntentLatestChargeExpanded(cs: Stripe.Checkout.Session): Stripe.Checkout.Session & { payment_intent: { latest_charge: object } | null } {
  if (typeof cs.payment_intent === 'string') throw new Error('checkoutSession.payment_intent is not expanded');
  if (cs.payment_intent == null) return cs as any;
  assertLatestChargeExpanded(cs.payment_intent);
  return cs as any;
}

function assertLatestChargeExpanded(pi: Stripe.PaymentIntent): Stripe.PaymentIntent & { latest_charge: object } {
  if (typeof pi.latest_charge === 'string') throw new Error('paymentIntent.latest_charge is not expanded');
  return pi as Stripe.PaymentIntent & { latest_charge: object };
}

// Payment Intentに紐づく成功したChargeは最大で一つなので、それさえ見れば問題はない
// ref. https://www.reddit.com/r/stripe/comments/j28rgf/comment/g741e5n
function latestChargeOfPaymentIntent(paymentIntent: Stripe.PaymentIntent) {
  if (paymentIntent.latest_charge == null) return paymentIntent.latest_charge;
  if (typeof paymentIntent.latest_charge === 'object') return paymentIntent.latest_charge;
  throw new Error(`paymentIntent.latest_charge is not expanded: ${paymentIntent.latest_charge}`);
}
