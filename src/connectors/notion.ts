/**
 * Notion コネクタ。
 *
 * SDK を使わず fetch で直接叩く。依存を増やさず、何を送って何を受けているかが
 * このファイルだけで分かる状態を保つため。
 *
 * 取り込むのは「利用者が連携を許可したページ」だけ。Notion の OAuth 画面で
 * 利用者がページを選ぶので、こちらからワークスペース全体を読むことはできない。
 * これが要件書 FR-003（取り込み範囲をユーザーが選択できる）の担保になっている。
 *
 * API バージョンは固定する。Notion は破壊的変更をバージョンで区切るため、
 * 固定しないと向こうの更新でいきなり壊れる。
 */

const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export interface NotionTokenResponse {
  access_token: string;
  workspace_id?: string;
  workspace_name?: string;
  bot_id?: string;
}

export interface NotionPage {
  id: string;
  title: string;
  url: string;
  lastEditedTime: string | null;
}

/** テストから差し替えられるようにしておく。 */
export type Fetcher = typeof fetch;

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const u = new URL(`${API}/oauth/authorize`);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('owner', 'user');
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  return u.toString();
}

/** 認可コードをトークンに交換する。client_secret は Basic 認証で送る。 */
export async function exchangeCode(
  opts: { clientId: string; clientSecret: string; redirectUri: string; code: string },
  f: Fetcher = fetch,
): Promise<NotionTokenResponse> {
  const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
  const res = await f(`${API}/oauth/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/json',
      'Notion-Version': NOTION_VERSION,
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`Notion のトークン取得に失敗しました（${res.status}）: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as NotionTokenResponse;
}

async function api(token: string, path: string, init: RequestInit, f: Fetcher): Promise<unknown> {
  const res = await f(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'Notion-Version': NOTION_VERSION,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (res.status === 401) throw new NotionAuthError('Notion の認可が切れています。接続し直してください。');
  if (!res.ok) {
    throw new Error(`Notion API エラー（${res.status} ${path}）: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/** 認可が切れた場合。呼び出し側で接続状態を revoked に落とすために型で区別する。 */
export class NotionAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotionAuthError';
  }
}

/**
 * 連携を許可されたページを列挙する。
 * search は「このインテグレーションがアクセスできるもの」しか返さないので、
 * 利用者が選んでいないページは出てこない。
 */
export async function listPages(token: string, f: Fetcher = fetch): Promise<NotionPage[]> {
  const out: NotionPage[] = [];
  let cursor: string | undefined;
  // ページ数が多い場合に無限に回らないよう上限を置く
  for (let i = 0; i < 20; i++) {
    const body: Record<string, unknown> = {
      filter: { value: 'page', property: 'object' },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const json = (await api(token, '/search', { method: 'POST', body: JSON.stringify(body) }, f)) as {
      results?: unknown[];
      has_more?: boolean;
      next_cursor?: string | null;
    };
    for (const raw of json.results ?? []) out.push(toPage(raw));
    if (!json.has_more || !json.next_cursor) break;
    cursor = json.next_cursor;
  }
  return out;
}

function toPage(raw: unknown): NotionPage {
  const p = raw as {
    id: string;
    url?: string;
    last_edited_time?: string;
    properties?: Record<string, { type?: string; title?: Array<{ plain_text?: string }> }>;
  };
  let title = '';
  for (const prop of Object.values(p.properties ?? {})) {
    if (prop?.type === 'title' && Array.isArray(prop.title)) {
      title = prop.title.map((t) => t.plain_text ?? '').join('');
      break;
    }
  }
  return {
    id: p.id,
    title: title.trim() || '(無題のページ)',
    url: p.url ?? `https://www.notion.so/${p.id.replace(/-/g, '')}`,
    lastEditedTime: p.last_edited_time ?? null,
  };
}

/** ページ本文を Markdown として取り出す。 */
export async function fetchPageMarkdown(token: string, pageId: string, f: Fetcher = fetch): Promise<string> {
  const lines = await blocksToMarkdown(token, pageId, f, 0);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function blocksToMarkdown(token: string, blockId: string, f: Fetcher, depth: number): Promise<string[]> {
  // 入れ子が深すぎる場合の暴走を防ぐ
  if (depth > 3) return [];
  const out: string[] = [];
  let cursor: string | undefined;

  for (let i = 0; i < 20; i++) {
    const qs = cursor ? `?start_cursor=${encodeURIComponent(cursor)}&page_size=100` : '?page_size=100';
    const json = (await api(token, `/blocks/${blockId}/children${qs}`, { method: 'GET' }, f)) as {
      results?: unknown[];
      has_more?: boolean;
      next_cursor?: string | null;
    };

    for (const raw of json.results ?? []) {
      const b = raw as { id: string; type: string; has_children?: boolean } & Record<string, unknown>;
      const text = renderBlock(b);
      if (text !== null) out.push(text);
      if (b.has_children && b.type !== 'child_page') {
        const nested = await blocksToMarkdown(token, b.id, f, depth + 1);
        for (const line of nested) out.push(depth < 3 ? `  ${line}` : line);
      }
    }
    if (!json.has_more || !json.next_cursor) break;
    cursor = json.next_cursor;
  }
  return out;
}

/** 1ブロックを Markdown の1行にする。扱えない種別は null（無視）。 */
function renderBlock(b: { type: string } & Record<string, unknown>): string | null {
  const rich = (key: string): string => {
    const node = b[key] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
    return (node?.rich_text ?? []).map((t) => t.plain_text ?? '').join('');
  };

  switch (b.type) {
    case 'paragraph': {
      const t = rich('paragraph');
      return t ? `\n${t}\n` : '';
    }
    case 'heading_1':
      return `\n# ${rich('heading_1')}\n`;
    case 'heading_2':
      return `\n## ${rich('heading_2')}\n`;
    case 'heading_3':
      return `\n### ${rich('heading_3')}\n`;
    case 'bulleted_list_item':
      return `- ${rich('bulleted_list_item')}`;
    case 'numbered_list_item':
      return `1. ${rich('numbered_list_item')}`;
    case 'to_do': {
      const node = b.to_do as { checked?: boolean } | undefined;
      return `- [${node?.checked ? 'x' : ' '}] ${rich('to_do')}`;
    }
    case 'quote':
      return `> ${rich('quote')}`;
    case 'callout':
      return `> ${rich('callout')}`;
    case 'toggle':
      return `- ${rich('toggle')}`;
    case 'code': {
      const node = b.code as { language?: string } | undefined;
      return `\n\`\`\`${node?.language ?? ''}\n${rich('code')}\n\`\`\`\n`;
    }
    case 'divider':
      return '\n---\n';
    case 'table_row': {
      const node = b.table_row as { cells?: Array<Array<{ plain_text?: string }>> } | undefined;
      const cells = (node?.cells ?? []).map((c) => c.map((t) => t.plain_text ?? '').join('').trim());
      return `| ${cells.join(' | ')} |`;
    }
    // 画像・埋め込み・子DBなどは本文として持たない。出典URLで元に戻れる。
    default:
      return null;
  }
}
