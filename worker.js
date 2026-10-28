/**
 * ai.vixle.top — Cloudflare Worker
 *  /api/models        GET  -> список моделей из KV (или дефолт)
 *  /api/models        POST -> сохранение списка (Authorization: Bearer 1234)
 *  /api/models/reset  POST -> сброс к дефолту
 *  /api/key/resolve   GET  -> код доступа -> идентификатор группы
 *  /api/keys          GET/POST -> коды доступа (admin)
 *  /api/key/guest     GET  -> гостевой код для входа без своего
 *  /api/guestlog      GET(admin)/POST -> журнал гостевых диалогов
 *  /api/guestlog/clear POST -> очистка журнала (admin)
 *  /api/usage         GET  -> расход по устройствам для ключа (?key=<хэш>)
 *  /api/usage         POST -> инкремент расхода устройства
 *  /api/usage/keys    GET  -> группы ключей (admin)
 *  /api/usage/balance GET  -> реальный расход ключа у OpenRouter (admin)
 *  /api/usage/color   POST -> свой цвет (нужен сырой id устройства)
 *  /api/usage/rename  POST -> правка устройства: имя, цвет, показываемые числа (admin)
 *  /api/usage/reset   POST -> обнуление счётчиков (admin)
 *  /api/v1/*          ->  https://openrouter.ai/api/v1/*   (стриминг сохраняется)
 *  всё остальное      ->  https://xaliithh-netizen.github.io/not_ai/
 *
 * Binding KV: MODELS_STORE
 * Опционально Secret/Var: ADMIN_TOKEN (по умолчанию "1234")
 */

const KV_KEY = 'models_list';
const ADMIN_TOKEN_FALLBACK = '1234';
const UPSTREAM_ORIGIN = 'https://openrouter.ai';
const SITE_BASE = 'https://xaliithh-netizen.github.io/not_ai';

/* ---------- Дефолтный список моделей ---------- */
const DEFAULT_MODELS = [
  {
    id: 'google/gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    description: 'Быстрая универсальная модель нового поколения',
    icon: 'gemini',
    vision: true,
    free: false,
    supportsTools: true,
    maxTokens: 8192,
    provider: null,
    reasoning: null,
    reasoningOptions: []
  },
  {
    id: 'openai/gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    description: 'Логика, код и точные вычисления. Настраиваемое рассуждение.',
    icon: 'chatgpt',
    vision: true,
    free: false,
    supportsTools: true,
    maxTokens: 32000,
    provider: null,
    reasoning: { effort: 'medium' },
    reasoningOptions: ['medium', 'high']
  },
  {
    id: 'deepseek/deepseek-v4-flash-latest',
    name: 'DeepSeek V4 Flash',
    description: 'Баланс скорости и интеллекта. Только провайдер Decart.',
    icon: 'deepseek',
    vision: false,
    free: false,
    supportsTools: true,
    maxTokens: 16000,
    provider: { order: ['decart'], allow_fallbacks: false },
    reasoning: null,
    reasoningOptions: []
  },
  {
    id: 'google/gemma-4-26b-a4b-it:free',
    name: 'Gemma 4 26B',
    description: 'Бесплатная лёгкая и сообразительная модель от Google',
    icon: 'gemma',
    vision: true,
    free: true,
    supportsTools: false,
    maxTokens: 8000,
    provider: null,
    reasoning: null,
    reasoningOptions: []
  }
];

/* ---------- helpers ---------- */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Title, HTTP-Referer',
  'Access-Control-Max-Age': '86400'
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS
    }
  });

/* Любое значение effort, которое понимает апстрим: minimal/low/medium/high,
   а также специфичные для отдельных моделей — xhigh, none и т.п.
   Ограничиваем только формат, а не набор значений. */
const isEffort = (v) => /^[a-z][a-z0-9_-]{0,15}$/i.test(String(v));

/* temperature: null = не отправлять, модель решает сама. 0 — валидное значение */
function normTemperature(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!isFinite(n) || n < 0 || n > 2) return null;
  return Math.round(n * 100) / 100;
}

/* гонка: id участников и окно выбора победителя (мс) */
const POOL_MAX = 8;
function normPool(raw, selfId) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    const id = String(v || '').trim();
    if (!id || id.length > 120 || !id.includes('/') || id === selfId || out.includes(id)) continue;
    out.push(id);
    if (out.length >= POOL_MAX) break;
  }
  return out;
}
function normRaceWindow(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 10000 ? Math.round(n) : 1500;
}

function normalizeModel(m) {
  const id = String(m.id || '').trim();
  const provider =
    m.provider && typeof m.provider === 'object' && Array.isArray(m.provider.order) && m.provider.order.length
      ? { order: m.provider.order.map(String), allow_fallbacks: m.provider.allow_fallbacks !== false }
      : null;
  const effort = m.reasoning && typeof m.reasoning === 'object' ? String(m.reasoning.effort || '') : '';
  return {
    id,
    name: String(m.name || id),
    description: String(m.description || ''),
    icon: String(m.icon || 'gemini'),
    color: normColor(m.color),
    vision: m.vision !== false,
    free: !!m.free,
    supportsTools: m.supportsTools !== false,
    maxTokens: Number(m.maxTokens) > 0 ? Number(m.maxTokens) : 8192,
    temperature: normTemperature(m.temperature),
    provider,
    reasoning: isEffort(effort) ? { effort } : null,
    reasoningOptions: Array.isArray(m.reasoningOptions)
      ? m.reasoningOptions.filter(isEffort).map(String)
      : [],
    /* undefined = ещё не проверяли: админка сама определит по провайдерам */
    nativeSearch: m.nativeSearch === undefined ? undefined : !!m.nativeSearch,
    pool: normPool(m.pool, id),
    raceWindow: normRaceWindow(m.raceWindow)
  };
}

function validateModels(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'Ожидается JSON-массив моделей' };
  if (list.length === 0) return { ok: false, error: 'Список не может быть пустым' };
  if (list.length > 100) return { ok: false, error: 'Слишком много моделей (максимум 100)' };
  const models = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'Элемент списка должен быть объектом' };
    const m = normalizeModel(raw);
    if (!m.id || !m.id.includes('/')) return { ok: false, error: `Некорректный id модели: "${m.id}"` };
    if (seen.has(m.id)) return { ok: false, error: `Дубликат модели: ${m.id}` };
    seen.add(m.id);
    models.push(m);
  }
  return { ok: true, models };
}

function isAuthorized(request, env) {
  const token = env.ADMIN_TOKEN || ADMIN_TOKEN_FALLBACK;
  const auth = request.headers.get('Authorization') || '';
  return auth.trim() === `Bearer ${token}`;
}


/* ---------- коды доступа вместо API-ключа ----------
   В KV лежат пары «код -> настоящий ключ OpenRouter». Клиент присылает код
   в Authorization, воркер подменяет его на ключ. Сам ключ браузеру не отдаётся. */
const CODES_KEY = 'access_codes';
const GUESTLOG_KEY = 'guest_log';
const GUESTLOG_MAX = 200;
const CODES_TTL = 30000;                 // кэш в памяти изолята
let codesCache = { at: 0, list: null };

async function sha16(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return Array.from(new Uint8Array(buf)).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function loadCodes(env) {
  if (!env.MODELS_STORE) return [];
  if (codesCache.list && Date.now() - codesCache.at < CODES_TTL) return codesCache.list;
  let list = [];
  try {
    const stored = await env.MODELS_STORE.get(CODES_KEY, 'json');
    if (Array.isArray(stored)) list = stored;
  } catch (e) {
    console.error('KV codes read error', e);
  }
  codesCache = { at: Date.now(), list };
  return list;
}

function findCode(list, value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return null;
  for (const c of list) {
    if (c && c.enabled !== false && String(c.code) === v) return c;
  }
  return null;
}

const maskKey = (k) => {
  const s = String(k || '');
  return s.length <= 14 ? '••••••' : s.slice(0, 10) + '…' + s.slice(-4);
};

/* ---------- учёт расхода по устройствам ----------
   Ключи KV: u:<хэш ключа>:<id устройства> -> { name, cost, requests, first, last }
   Отдельный ключ на устройство, чтобы параллельные записи с разных ноутбуков
   не затирали друг друга. */
const USAGE_PREFIX = 'u:';
const isHex = (v, len) => typeof v === 'string' && new RegExp('^[a-f0-9]{' + len + '}$').test(v);
const usageKey = (keyHash, device) => USAGE_PREFIX + keyHash + ':' + device;

function cleanName(v, fallback) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s ? s.slice(0, 40) : fallback;
}

/* #rrggbb или пусто (= цвет подбирается автоматически) */
const normColor = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || '').trim()) ? String(v).trim().toLowerCase() : null);

/* число или null (пусто/мусор = подмены нет) */
function normNum(v, max) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!isFinite(n) || n < -max || n > max) return null;
  return n;
}

/* Подмена хранится смещением: показываем (настоящее − смещение).
   Поэтому новые траты прибавляются и к показанному числу. */
function shownValue(real, offset, whole) {
  if (offset === null) return whole ? Math.round(real) : real;
  const v = real - offset;
  if (v <= 0) return 0;
  return whole ? Math.round(v) : Math.round(v * 1e6) / 1e6;
}

/* разбивка по моделям: { "vendor/model": { cost, requests } } */
function cleanModels(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  let n = 0;
  for (const id of Object.keys(raw)) {
    if (n >= 60) break;
    if (typeof id !== 'string' || id.length > 120 || !id.includes('/')) continue;
    const v = raw[id] || {};
    const cost = Number(v.cost);
    const reqs = Number(v.requests);
    if (!isFinite(cost) || cost < 0 || cost > 50) continue;
    out[id] = {
      cost: Math.round(cost * 1e6) / 1e6,
      requests: isFinite(reqs) && reqs > 0 ? Math.min(Math.floor(reqs), 100) : 0
    };
    n++;
  }
  return out;
}

function mergeModels(prev, add) {
  const out = (prev && typeof prev === 'object') ? { ...prev } : {};
  for (const id of Object.keys(add)) {
    const was = out[id] || { cost: 0, requests: 0 };
    out[id] = {
      cost: Math.round(((Number(was.cost) || 0) + add[id].cost) * 1e6) / 1e6,
      requests: (Number(was.requests) || 0) + add[id].requests
    };
  }
  /* держим не больше 60 моделей на устройство: лишние самые дешёвые отбрасываем */
  const ids = Object.keys(out);
  if (ids.length > 60) {
    ids.sort((a, b) => (out[b].cost || 0) - (out[a].cost || 0));
    const keep = {};
    ids.slice(0, 60).forEach((id) => { keep[id] = out[id]; });
    return keep;
  }
  return out;
}

/* то, что видит сайт */
function publicRecord(rec) {
  const realCost = Number(rec.cost) || 0;
  const realReq = Number(rec.requests) || 0;
  const cost = shownValue(realCost, normNum(rec.costOffset, 1e6), false);
  const requests = shownValue(realReq, normNum(rec.requestsOffset, 1e9), true);
  /* разбивку масштабируем под показываемую сумму, иначе подмена выдала бы себя */
  const kCost = realCost > 0 ? cost / realCost : 0;
  const kReq = realReq > 0 ? requests / realReq : 0;
  const src = (rec.models && typeof rec.models === 'object') ? rec.models : {};
  const models = {};
  for (const id of Object.keys(src)) {
    models[id] = {
      cost: Math.round(((Number(src[id].cost) || 0) * kCost) * 1e6) / 1e6,
      requests: Math.round((Number(src[id].requests) || 0) * kReq)
    };
  }
  return {
    name: rec.name || '',
    cost,
    requests,
    models,
    color: normColor(rec.color),
    first: rec.first || 0,
    last: rec.last || 0
  };
}

async function usageList(env, keyHash, full) {
  if (!env.MODELS_STORE) return [];
  const prefix = USAGE_PREFIX + keyHash + ':';
  const out = [];
  let cursor;
  do {
    const page = await env.MODELS_STORE.list({ prefix, cursor });
    for (const k of page.keys) {
      const rec = await env.MODELS_STORE.get(k.name, 'json');
      if (!rec) continue;
      const device = k.name.slice(prefix.length);
      /* наружу отдаём метку, а не сырой id: по ней владелец узнаёт себя,
         но чужой id из списка не вытащить и чужой цвет не поменять */
      const base = { tag: await sha16(keyHash + ':' + device), ...publicRecord(rec) };
      if (full) {
        base.device = device;
        base.realCost = Number(rec.cost) || 0;
        base.realRequests = Number(rec.requests) || 0;
        base.costOffset = normNum(rec.costOffset, 1e6);
        base.requestsOffset = normNum(rec.requestsOffset, 1e9);
        base.realModels = (rec.models && typeof rec.models === 'object') ? rec.models : {};
      }
      out.push(base);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out.sort((a, b) => (b.cost || 0) - (a.cost || 0));
}

async function usageGroups(env) {
  if (!env.MODELS_STORE) return [];
  const groups = {};
  let cursor;
  do {
    const page = await env.MODELS_STORE.list({ prefix: USAGE_PREFIX, cursor });
    for (const k of page.keys) {
      const parts = k.name.slice(USAGE_PREFIX.length).split(':');
      if (parts.length !== 2) continue;
      const rec = await env.MODELS_STORE.get(k.name, 'json');
      if (!rec) continue;
      const g = groups[parts[0]] || (groups[parts[0]] = { key: parts[0], devices: 0, cost: 0, last: 0 });
      g.devices++;
      g.cost = Math.round((g.cost + (Number(rec.cost) || 0)) * 1e6) / 1e6;
      g.last = Math.max(g.last, Number(rec.last) || 0);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return Object.values(groups).sort((a, b) => b.last - a.last);
}

async function usageDelete(env, keyHash, device) {
  if (!env.MODELS_STORE) return 0;
  if (device) { await env.MODELS_STORE.delete(usageKey(keyHash, device)); return 1; }
  const prefix = USAGE_PREFIX + keyHash + ':';
  let cursor, n = 0;
  do {
    const page = await env.MODELS_STORE.list({ prefix, cursor });
    for (const k of page.keys) { await env.MODELS_STORE.delete(k.name); n++; }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return n;
}


/* ---------- прокси на OpenRouter ---------- */
async function proxyOpenRouter(request, url, env) {
  const target = UPSTREAM_ORIGIN + '/api' + url.pathname.slice('/api'.length) + url.search;

  const headers = new Headers(request.headers);
  ['host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip']
    .forEach((h) => headers.delete(h));
  /* если прислали код доступа — подставляем настоящий ключ */
  const auth = (headers.get('Authorization') || '').trim();
  if (auth.slice(0, 7).toLowerCase() === 'bearer ') {
    const entry = findCode(await loadCodes(env), auth.slice(7).trim());
    if (entry) headers.set('Authorization', 'Bearer ' + entry.key);
  }

  if (!headers.has('HTTP-Referer')) headers.set('HTTP-Referer', 'https://ai.vixle.top');
  if (!headers.has('X-Title')) headers.set('X-Title', 'not ai');

  const init = { method: request.method, headers, redirect: 'follow' };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = request.body;

  const resp = await fetch(target, init);
  const out = new Headers(resp.headers);
  out.set('Access-Control-Allow-Origin', '*');
  out.set('Cache-Control', 'no-store');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: out });
}

/* ---------- отдача сайта с GitHub Pages ---------- */
async function serveSite(request, url) {
  let path = url.pathname;
  if (path === '/' || path === '') path = '/index.html';
  const fileName = path.split('/').pop() || '';
  const isFile = fileName.includes('.');

  const load = (p) =>
    fetch(SITE_BASE + p + url.search, {
      headers: { 'User-Agent': request.headers.get('User-Agent') || 'CF-Worker', Accept: request.headers.get('Accept') || '*/*' },
      cf: { cacheTtl: isFile ? 300 : 0, cacheEverything: isFile }
    });

  let resp = await load(path);
  if (resp.status === 404 && !isFile) resp = await load('/index.html');

  const headers = new Headers(resp.headers);
  headers.delete('content-security-policy');
  headers.delete('x-frame-options');
  if (!isFile || path.endsWith('.html')) headers.set('Cache-Control', 'no-cache, must-revalidate');
  return new Response(resp.body, { status: resp.status, headers });
}

/* ---------- entry point ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null ,{ status: 204, headers: CORS });

    /* ---- /api/models ---- */
    if (path === '/api/models') {
      if (request.method === 'GET') {
        try {
          if (env.MODELS_STORE) {
            const stored = await env.MODELS_STORE.get(KV_KEY, 'json');
            if (Array.isArray(stored) && stored.length) return json(stored);
          }
        } catch (e) {
          console.error('KV read error', e);
        }
        return json(DEFAULT_MODELS);
      }

      if (request.method === 'POST') {
        if (!isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
        if (!env.MODELS_STORE) return json({ error: 'KV binding MODELS_STORE не настроен' }, 500);

        let payload;
        try {
          payload = await request.json();
        } catch {
          return json({ error: 'Некорректный JSON' }, 400);
        }
        const list = Array.isArray(payload) ? payload : payload && payload.models;
        const v = validateModels(list);
        if (!v.ok) return json({ error: v.error }, 400);

        await env.MODELS_STORE.put(KV_KEY, JSON.stringify(v.models));
        return json({ ok: true, count: v.models.length, models: v.models, updatedAt: new Date().toISOString() });
      }

      return json({ error: 'Method Not Allowed' }, 405);
    }

    /* ---- сброс к дефолту ---- */
    if (path === '/api/models/reset' && request.method === 'POST') {
      if (!isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
      if (env.MODELS_STORE) await env.MODELS_STORE.delete(KV_KEY);
      return json({ ok: true, models: DEFAULT_MODELS });
    }

    /* ---- расход по устройствам ---- */
    if (path === '/api/usage') {
      if (request.method === 'GET') {
        const keyHash = url.searchParams.get('key') || '';
        if (!isHex(keyHash, 16)) return json({ error: 'Некорректный идентификатор ключа' }, 400);
        /* настоящие суммы видны только с админ-токеном */
        return json({ devices: await usageList(env, keyHash, isAuthorized(request, env)) });
      }

      if (request.method === 'POST') {
        if (!env.MODELS_STORE) return json({ error: 'KV binding MODELS_STORE не настроен' }, 500);
        let p;
        try { p = await request.json(); } catch { return json({ error: 'Некорректный JSON' }, 400); }

        const keyHash = String(p.key || '');
        const device = String(p.device || '');
        if (!isHex(keyHash, 16) || !isHex(device, 12)) return json({ error: 'Некорректные идентификаторы' }, 400);

        const cost = Number(p.cost);
        if (!isFinite(cost) || cost < 0 || cost > 50) return json({ error: 'Некорректная стоимость' }, 400);
        const reqs = Number(p.requests);

        const k = usageKey(keyHash, device);
        const prev = (await env.MODELS_STORE.get(k, 'json')) || null;
        const now = Date.now();
        const rec = {
          ...(prev || {}),
          /* имя задаётся один раз: переименование из админки не перетирается автоименем клиента */
          name: (prev && prev.name) || cleanName(p.name, 'Устройство ' + device.slice(0, 4)),
          cost: Math.round((((prev && prev.cost) || 0) + cost) * 1e6) / 1e6,
          requests: ((prev && prev.requests) || 0) + (isFinite(reqs) && reqs > 0 ? Math.min(Math.floor(reqs), 100) : 0),
          models: mergeModels(prev && prev.models, cleanModels(p.models)),
          first: (prev && prev.first) || now,
          last: now
        };
        await env.MODELS_STORE.put(k, JSON.stringify(rec));
        /* в ответ отдаём только публичный вид: настоящие суммы — лишь по админ-токену */
        return json({ ok: true, device, ...publicRecord(rec) });
      }

      return json({ error: 'Method Not Allowed' }, 405);
    }

    /* ---- свой цвет (без админки) ----
       Менять можно только своё устройство: нужен сырой id, который есть
       лишь у владельца — наружу в списке отдаётся только его хэш-метка. */
    if (path === '/api/usage/color' && request.method === 'POST') {
      if (!env.MODELS_STORE) return json({ error: 'KV binding MODELS_STORE не настроен' }, 500);
      let p;
      try { p = await request.json(); } catch { return json({ error: 'Некорректный JSON' }, 400); }

      const keyHash = String(p.key || '');
      const device = String(p.device || '');
      if (!isHex(keyHash, 16) || !isHex(device, 12)) return json({ error: 'Некорректные идентификаторы' }, 400);

      const color = normColor(p.color);
      if (p.color !== '' && color === null) return json({ error: 'Цвет должен быть в виде #rrggbb' }, 400);

      const k = usageKey(keyHash, device);
      const rec = await env.MODELS_STORE.get(k, 'json');
      if (!rec) return json({ error: 'Устройство не найдено' }, 404);

      rec.color = color;
      await env.MODELS_STORE.put(k, JSON.stringify(rec));
      return json({ ok: true, tag: await sha16(keyHash + ':' + device), color });
    }

    /* ---- реальный расход ключа у OpenRouter (admin) ----
       Группа — это sha16 от настоящего ключа, поэтому ключ ищем среди сохранённых кодов. */
    if (path === '/api/usage/balance' && request.method === 'GET') {
      if (!isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
      const keyHash = url.searchParams.get('key') || '';
      if (!isHex(keyHash, 16)) return json({ error: 'Некорректный идентификатор ключа' }, 400);

      let real = null;
      for (const c of await loadCodes(env)) {
        if (c && c.key && (await sha16(c.key)) === keyHash) { real = c.key; break; }
      }
      if (!real) return json({ ok: false, error: 'Для этой группы нет сохранённого ключа — добавьте его в «Коды»' }, 404);

      try {
        const r = await fetch(UPSTREAM_ORIGIN + '/api/v1/auth/key', {
          headers: { 'Authorization': 'Bearer ' + real, 'HTTP-Referer': 'https://ai.vixle.top', 'X-Title': 'not ai' }
        });
        if (!r.ok) return json({ ok: false, error: 'OpenRouter ответил HTTP ' + r.status }, 502);
        const d = await r.json();
        const data = (d && d.data) || {};
        return json({
          ok: true,
          limit: data.limit === null || data.limit === undefined ? 0 : Number(data.limit) || 0,
          usage: Number(data.usage) || 0
        });
      } catch (e) {
        return json({ ok: false, error: 'Не удалось получить баланс: ' + (e && e.message) }, 502);
      }
    }

    /* ---- список групп (по ключам) для админки ---- */
    if (path === '/api/usage/keys' && request.method === 'GET') {
      if (!isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
      return json({ groups: await usageGroups(env) });
    }

    /* ---- переименование устройства ---- */
    if (path === '/api/usage/rename' && request.method === 'POST') {
      if (!isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
      if (!env.MODELS_STORE) return json({ error: 'KV binding MODELS_STORE не настроен' }, 500);
      let p;
      try { p = await request.json(); } catch { return json({ error: 'Некорректный JSON' }, 400); }

      const keyHash = String(p.key || '');
      const device = String(p.device || '');
      if (!isHex(keyHash, 16) || !isHex(device, 12)) return json({ error: 'Некорректные идентификаторы' }, 400);

      const k = usageKey(keyHash, device);
      const rec = await env.MODELS_STORE.get(k, 'json');
      if (!rec) return json({ error: 'Устройство не найдено' }, 404);
      if (p.name !== undefined) rec.name = cleanName(p.name, rec.name || 'Устройство ' + device.slice(0, 4));
      if (p.color !== undefined) rec.color = normColor(p.color);
      /* в админке вводится то, что должно показываться сейчас; храним разницу */
      if (p.showCost !== undefined) {
        const want = normNum(p.showCost, 1e6);
        rec.costOffset = want === null ? null : Math.round(((Number(rec.cost) || 0) - want) * 1e6) / 1e6;
      }
      if (p.showRequests !== undefined) {
        const want = normNum(p.showRequests, 1e9);
        rec.requestsOffset = want === null ? null : Math.round((Number(rec.requests) || 0) - want);
      }
      await env.MODELS_STORE.put(k, JSON.stringify(rec));
      /* отвечаем админскими данными: и настоящими, и подменными */
      return json({
        ok: true, device, tag: await sha16(keyHash + ':' + device), ...publicRecord(rec),
        realCost: Number(rec.cost) || 0,
        realRequests: Number(rec.requests) || 0,
        costOffset: normNum(rec.costOffset, 1e6),
        requestsOffset: normNum(rec.requestsOffset, 1e9)
      });
    }

    /* ---- обнуление счётчиков ---- */
    if (path === '/api/usage/reset' && request.method === 'POST') {
      if (!isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
      let p;
      try { p = await request.json(); } catch { return json({ error: 'Некорректный JSON' }, 400); }

      const keyHash = String(p.key || '');
      const device = p.device ? String(p.device) : '';
      if (!isHex(keyHash, 16)) return json({ error: 'Некорректный идентификатор ключа' }, 400);
      if (device && !isHex(device, 12)) return json({ error: 'Некорректный идентификатор устройства' }, 400);
      const removed = await usageDelete(env, keyHash, device);
      return json({ ok: true, removed });
    }

    /* ---- код доступа -> идентификатор группы (ключ не отдаём) ---- */
    if (path === '/api/key/resolve' && request.method === 'GET') {
      const entry = findCode(await loadCodes(env), url.searchParams.get('code') || '');
      if (!entry) return json({ ok: false, error: 'Код не найден' }, 404);
      return json({ ok: true, keyId: await sha16(entry.key), label: entry.label || '', guest: !!entry.guest });
    }

    /* ---- гостевой код: выдаётся сайтом тому, кто пришёл без своего ---- */
    if (path === '/api/key/guest' && request.method === 'GET') {
      const entry = (await loadCodes(env)).find((c) => c && c.guest && c.enabled !== false);
      if (!entry) return json({ ok: false, error: 'Гостевой код не назначен' }, 404);
      return json({ ok: true, code: entry.code, keyId: await sha16(entry.key), label: entry.label || '' });
    }

    /* ---- журнал гостевых диалогов ----
       Пишется только для гостевого кода. На сайте об этом сказано прямым текстом:
       гостевой режим — общий ключ владельца, переписка в нём не приватна. */
    if (path === '/api/guestlog') {
      if (request.method === 'GET') {
        if (!isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
        const stored = env.MODELS_STORE ? await env.MODELS_STORE.get(GUESTLOG_KEY, 'json') : null;
        return json({ entries: Array.isArray(stored) ? stored : [] });
      }

      if (request.method === 'POST') {
        if (!env.MODELS_STORE) return json({ error: 'KV binding MODELS_STORE не настроен' }, 500);
        let p;
        try { p = await request.json(); } catch { return json({ error: 'Некорректный JSON' }, 400); }

        /* принимаем запись только если прислан действующий гостевой код */
        const guest = (await loadCodes(env)).find((c) => c && c.guest && c.enabled !== false);
        if (!guest || String(p.code || '') !== String(guest.code)) return json({ error: 'Не гостевой код' }, 403);

        const cut = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, n);
        const entry = {
          at: Date.now(),
          tag: isHex(String(p.tag || ''), 16) ? String(p.tag) : '',
          model: cut(p.model, 120),
          q: cut(p.q, 1000),
          a: cut(p.a, 2000)
        };
        if (!entry.q && !entry.a) return json({ error: 'Пустая запись' }, 400);

        const stored = await env.MODELS_STORE.get(GUESTLOG_KEY, 'json');
        const list = Array.isArray(stored) ? stored : [];
        list.push(entry);
        await env.MODELS_STORE.put(GUESTLOG_KEY, JSON.stringify(list.slice(-GUESTLOG_MAX)));
        return json({ ok: true });
      }

      return json({ error: 'Method Not Allowed' }, 405);
    }

    if (path === '/api/guestlog/clear' && request.method === 'POST') {
      if (!isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
      if (env.MODELS_STORE) await env.MODELS_STORE.delete(GUESTLOG_KEY);
      return json({ ok: true });
    }

    /* ---- управление кодами (admin) ---- */
    if (path === '/api/keys') {
      if (!isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);

      if (request.method === 'GET') {
        const list = await loadCodes(env);
        const out = [];
        for (const c of list) {
          out.push({
            id: c.id,
            code: c.code,
            label: c.label || '',
            enabled: c.enabled !== false,
            guest: !!c.guest,
            keyMask: maskKey(c.key),
            keyId: await sha16(c.key)
          });
        }
        return json({ codes: out });
      }

      if (request.method === 'POST') {
        if (!env.MODELS_STORE) return json({ error: 'KV binding MODELS_STORE не настроен' }, 500);
        let payload;
        try { payload = await request.json(); } catch { return json({ error: 'Некорректный JSON' }, 400); }

        const incoming = Array.isArray(payload) ? payload : payload && payload.codes;
        if (!Array.isArray(incoming)) return json({ error: 'Ожидается массив кодов' }, 400);
        if (incoming.length > 50) return json({ error: 'Слишком много кодов (максимум 50)' }, 400);

        const prev = await loadCodes(env);
        const byId = {};
        prev.forEach((c) => { if (c && c.id) byId[c.id] = c; });

        const seen = new Set();
        const out = [];
        for (const raw of incoming) {
          if (!raw || typeof raw !== 'object') return json({ error: 'Элемент списка должен быть объектом' }, 400);
          const code = String(raw.code || '').trim();
          if (code.length < 3 || code.length > 64) return json({ error: `Код «${code}» должен быть от 3 до 64 символов` }, 400);
          if (/\s/.test(code)) return json({ error: `В коде «${code}» не должно быть пробелов` }, 400);
          if (seen.has(code)) return json({ error: `Повтор кода: ${code}` }, 400);
          seen.add(code);

          const old = raw.id && byId[raw.id] ? byId[raw.id] : null;
          /* пустой key = ключ не меняли, оставляем сохранённый */
          const key = String(raw.key || '').trim() || (old ? String(old.key || '') : '');
          if (!key) return json({ error: `Для кода «${code}» не указан ключ OpenRouter` }, 400);

          out.push({
            id: old ? old.id : crypto.randomUUID().slice(0, 8),
            code,
            key,
            label: String(raw.label || '').slice(0, 60),
            enabled: raw.enabled !== false,
            guest: !!raw.guest
          });
        }

        /* гостевой код может быть только один */
        let seenGuest = false;
        for (const c of out) {
          if (c.guest && seenGuest) c.guest = false;
          else if (c.guest) seenGuest = true;
        }

        await env.MODELS_STORE.put(CODES_KEY, JSON.stringify(out));
        codesCache = { at: 0, list: null };
        return json({ ok: true, count: out.length });
      }

      return json({ error: 'Method Not Allowed' }, 405);
    }

    /* ---- прокси OpenRouter ---- */
    if (path.startsWith('/api/')) return proxyOpenRouter(request, url, env);

    /* ---- статика ---- */
    return serveSite(request, url);
  }
};