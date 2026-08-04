/**
 * 設定と料金プラン。
 *
 * 料金・上限はここだけを見れば分かる状態を保つ。
 * 値の変更は課金額に直結するため、変更時は必ず Stripe 側の Price と突き合わせる。
 */

export const config = {
  port: Number(process.env.PORT ?? 8787),
  /** 公開URL。Stripeのリダイレクトと、MCP接続手順の表示に使う。 */
  baseUrl: (process.env.BASE_URL ?? 'http://localhost:8787').replace(/\/$/, ''),
  /**
   * Neon の接続文字列。Vercel では必ず pooled（-pooler 付き）を使う。
   * サーバーレスは同時実行が増えるとDB接続を食い潰すため、直結にしない。
   * 未設定ならローカルの PGlite にフォールバックする。
   */
  databaseUrl: process.env.DATABASE_URL ?? '',
  /** PGlite のデータ置き場。未設定ならインメモリ（プロセス終了で消える）。 */
  pgliteDir: process.env.PGLITE_DIR ?? undefined,
  /** セッションCookieの署名鍵。本番では必ず設定する（未設定なら起動を止める）。 */
  sessionSecret: process.env.SESSION_SECRET ?? '',
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    /** Pro プランの Price ID（Stripeダッシュボードで作成したもの）。 */
    proPriceId: process.env.STRIPE_PRO_PRICE_ID ?? '',
  },
  /** 特定商取引法に基づく表記。日本で有料販売する場合、記載は法令上の義務。 */
  legal: {
    sellerName: process.env.LEGAL_SELLER_NAME ?? '',
    representative: process.env.LEGAL_REPRESENTATIVE ?? '',
    address: process.env.LEGAL_ADDRESS ?? '',
    phone: process.env.LEGAL_PHONE ?? '',
    email: process.env.LEGAL_EMAIL ?? '',
  },
} as const;

export type PlanId = 'free' | 'pro';

export interface Plan {
  id: PlanId;
  label: string;
  /** 月額（税込・円）。0 は無料。 */
  priceJpy: number;
  limits: {
    packs: number;
    documentsPerWorkspace: number;
    /** 暦月あたりの context_search 呼び出し上限。 */
    searchesPerMonth: number;
    /** 1ドキュメントの最大文字数。 */
    documentChars: number;
  };
  points: string[];
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    label: 'Free',
    priceJpy: 0,
    limits: { packs: 1, documentsPerWorkspace: 30, searchesPerMonth: 100, documentChars: 20_000 },
    points: [
      'Context Pack 1個',
      'ドキュメント 30件',
      '検索 100回/月',
      'MCP接続あり（Claude / Cursor）',
      'Markdownエクスポート',
    ],
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    priceJpy: 2980,
    limits: { packs: 20, documentsPerWorkspace: 2_000, searchesPerMonth: 5_000, documentChars: 200_000 },
    points: [
      'Context Pack 20個',
      'ドキュメント 2,000件',
      '検索 5,000回/月',
      'MCP接続あり（Claude / Cursor）',
      'Markdownエクスポート',
      'メールサポート',
    ],
  },
};

export function planOf(id: string | null | undefined): Plan {
  return id === 'pro' ? PLANS.pro : PLANS.free;
}

/** 検索結果の上限。要件書 §11.2 に合わせ、応答サイズを抑える。 */
export const SEARCH_LIMITS = {
  maxResults: 10,
  snippetChars: 300,
} as const;
