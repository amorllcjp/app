/**
 * 課金。Stripe Checkout（サブスクリプション） + Billing Portal + Webhook。
 *
 * プラン状態の正は常に Stripe 側にある。こちらの workspaces.plan は Webhook で追従する写しであり、
 * 画面の入力やリダイレクトの成否では更新しない（決済完了を装ったリクエストで昇格させないため）。
 */
import Stripe from 'stripe';
import type { Sql } from './db.ts';
import { nowIso, audit } from './db.ts';
import { config, PLANS } from './config.ts';

let client: Stripe | null = null;

export function stripe(): Stripe {
  if (!config.stripe.secretKey) throw new Error('STRIPE_SECRET_KEY が未設定です');
  if (!client) client = new Stripe(config.stripe.secretKey);
  return client;
}

export function billingConfigured(): boolean {
  return Boolean(config.stripe.secretKey && config.stripe.proPriceId);
}

async function customerIdOf(db: Sql, workspaceId: string): Promise<string | null> {
  const { rows } = await db.query<{ stripe_customer_id: string | null }>(
    'select stripe_customer_id from workspaces where id = $1',
    [workspaceId],
  );
  if (!rows[0]) throw new Error('ワークスペースが見つかりません');
  return rows[0].stripe_customer_id;
}

/** Checkout セッションを作り、その URL を返す。 */
export async function createCheckoutSession(db: Sql, workspaceId: string, email: string): Promise<string> {
  if (!billingConfigured()) throw new Error('決済が未設定です（STRIPE_SECRET_KEY / STRIPE_PRO_PRICE_ID）');
  const s = stripe();

  let customerId = await customerIdOf(db, workspaceId);
  if (!customerId) {
    const customer = await s.customers.create({ email, metadata: { workspace_id: workspaceId } });
    customerId = customer.id;
    await db.query('update workspaces set stripe_customer_id = $1 where id = $2', [customerId, workspaceId]);
  }

  const session = await s.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: config.stripe.proPriceId, quantity: 1 }],
    success_url: `${config.baseUrl}/app?upgraded=1`,
    cancel_url: `${config.baseUrl}/pricing?canceled=1`,
    // Webhook で workspace を特定できるようにする。
    subscription_data: { metadata: { workspace_id: workspaceId } },
    metadata: { workspace_id: workspaceId },
    locale: 'ja',
  });
  await audit(db, workspaceId, 'user', 'billing.checkout_started');
  if (!session.url) throw new Error('Checkout セッションのURLを取得できませんでした');
  return session.url;
}

/** 解約・支払い方法の変更は Stripe のポータルに任せる。自前で作らない。 */
export async function createPortalSession(db: Sql, workspaceId: string): Promise<string> {
  const customerId = await customerIdOf(db, workspaceId);
  if (!customerId) throw new Error('請求情報がまだありません');
  const session = await stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${config.baseUrl}/app`,
  });
  await audit(db, workspaceId, 'user', 'billing.portal_opened');
  return session.url;
}

/**
 * Webhook 処理。署名を検証してからプラン状態を更新する。
 * 署名検証に失敗したリクエストは一切反映しない。
 */
export async function handleWebhook(db: Sql, rawBody: string, signature: string | null): Promise<void> {
  if (!config.stripe.webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET が未設定です');
  if (!signature) throw new Error('署名がありません');

  const event = await stripe().webhooks.constructEventAsync(rawBody, signature, config.stripe.webhookSecret);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const workspaceId = session.metadata?.workspace_id;
      if (workspaceId && session.subscription) {
        const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
        const sub = await stripe().subscriptions.retrieve(subId);
        await applySubscription(db, workspaceId, sub);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const workspaceId = sub.metadata?.workspace_id ?? (await workspaceIdForCustomer(db, sub.customer));
      if (workspaceId) await applySubscription(db, workspaceId, sub);
      break;
    }
    case 'invoice.payment_failed': {
      const inv = event.data.object as Stripe.Invoice;
      const workspaceId = await workspaceIdForCustomer(db, inv.customer);
      if (workspaceId) {
        await db.query('update workspaces set plan_status = $1 where id = $2', ['past_due', workspaceId]);
        await audit(db, workspaceId, 'stripe', 'billing.payment_failed');
      }
      break;
    }
    default:
      break;
  }
}

async function workspaceIdForCustomer(
  db: Sql,
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
): Promise<string | null> {
  if (!customer) return null;
  const id = typeof customer === 'string' ? customer : customer.id;
  const { rows } = await db.query<{ id: string }>('select id from workspaces where stripe_customer_id = $1', [id]);
  return rows[0]?.id ?? null;
}

async function applySubscription(db: Sql, workspaceId: string, sub: Stripe.Subscription): Promise<void> {
  // active / trialing だけを Pro とみなす。canceled, unpaid, incomplete は free に戻す。
  const isPro = sub.status === 'active' || sub.status === 'trialing';
  const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;
  await db.query(
    `update workspaces
        set plan = $1, plan_status = $2, stripe_subscription_id = $3, current_period_end = $4
      where id = $5`,
    [
      isPro ? 'pro' : 'free',
      isPro ? 'active' : sub.status,
      sub.id,
      periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      workspaceId,
    ],
  );
  await audit(db, workspaceId, 'stripe', 'billing.subscription_updated', sub.id, {
    status: sub.status,
    plan: isPro ? 'pro' : 'free',
  });
}

/** 画面表示用。Stripe未設定でも落ちないようにする。 */
export async function billingSummary(db: Sql, workspaceId: string) {
  const { rows } = await db.query<{
    plan: string;
    plan_status: string;
    current_period_end: string | null;
    stripe_customer_id: string | null;
  }>(
    'select plan, plan_status, current_period_end::text, stripe_customer_id from workspaces where id = $1',
    [workspaceId],
  );
  const ws = rows[0];
  return {
    plan: ws?.plan ?? 'free',
    planLabel: (ws?.plan === 'pro' ? PLANS.pro : PLANS.free).label,
    status: ws?.plan_status ?? 'active',
    currentPeriodEnd: ws?.current_period_end ?? null,
    hasCustomer: Boolean(ws?.stripe_customer_id),
    configured: billingConfigured(),
    checkedAt: nowIso(),
  };
}
