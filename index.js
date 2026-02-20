require('dotenv').config();
const { createPublicClient, createWalletClient, http, parseUnits, formatUnits } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const {
  createNadoClient,
  CHAIN_ENV_TO_CHAIN,
  packOrderAppendix,
} = require('@nadohq/client');

/* ═══════════ CONFIG ═══════════ */

const PRODUCT_IDS   = [1, 2];
const SPREAD_PCT    = 0.00015;
const ORDER_SIZE    = '15';

// ██ ГЛАВНОЕ ИЗМЕНЕНИЕ: было 200мс → стало 5 сек
// 200мс = 30 запросов/сек → Cloudflare банит моментально
const TICK_MS       = 5000;

// Если 429 — увеличиваем паузу
const MAX_TICK_MS   = 60000;
const BACKOFF_MULT  = 2;

const LOG_INTERVAL  = 60_000;

/* ═══════════ HELPERS ═══════════ */

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function err(tag, e) {
  const text = e?.shortMessage || e?.message || String(e);
  // Обрезаем HTML от Cloudflare
  const clean = text.includes('<!DOCTYPE') 
    ? text.slice(0, text.indexOf('<!DOCTYPE')) + '[Cloudflare HTML blocked]'
    : text;
  console.error(`[${new Date().toISOString()}] ❌ ${tag}: ${clean.slice(0, 300)}`);
}

function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  return Number(v);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function is429(e) {
  const msg = e?.message || '';
  return msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('cf_chl');
}

/* ═══════════ CLIENT ═══════════ */

function getNadoClient(privateKey) {
  const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(pk);
  const chainConfig = CHAIN_ENV_TO_CHAIN.inkMainnet;

  const publicClient = createPublicClient({
    chain: chainConfig,
    transport: http(),
  });

  const walletClient = createWalletClient({
    account,
    chain: chainConfig,
    transport: http(),
  });

  const client = createNadoClient('inkMainnet', { publicClient, walletClient });

  log(`Wallet: ${account.address}`);

  // Показываем все доступные методы SDK
  for (const ns of Object.keys(client)) {
    if (typeof client[ns] !== 'object' || client[ns] === null) continue;
    const methods = Object.keys(client[ns]).filter(
      (m) => typeof client[ns][m] === 'function'
    );
    if (methods.length) {
      log(`  SDK "${ns}": [${methods.join(', ')}]`);
    }
  }

  return { client, account, publicClient, walletClient };
}

/* ═══════════ DEPOSIT ═══════════ */

async function ensureDeposit(client, address) {
  log('── Проверяю депозит на Nado ──');

  // 1) Ищем метод для проверки/создания депозита
  const allMethods = {};
  for (const ns of Object.keys(client)) {
    if (typeof client[ns] !== 'object' || client[ns] === null) continue;
    for (const m of Object.keys(client[ns])) {
      if (typeof client[ns][m] === 'function') {
        allMethods[`${ns}.${m}`] = client[ns][m].bind(client[ns]);
      }
    }
  }

  // 2) Пробуем найти баланс/аккаунт
  const balanceKeys = Object.keys(allMethods).filter((k) =>
    /balance|deposit|account|portfolio|collateral|margin|info/i.test(k)
  );

  log(`  Методы баланса/депозита: [${balanceKeys.join(', ') || 'НЕТ'}]`);

  for (const key of balanceKeys) {
    try {
      await sleep(500); // пауза между вызовами!
      const res = await allMethods[key]({ address });
      const dump = JSON.stringify(res, (_, v) =>
        typeof v === 'bigint' ? v.toString() : v
      ).slice(0, 500);
      log(`  ${key}() → ${dump}`);
    } catch (e) {
      err(`  ${key}`, e);
    }
  }

  // 3) Пробуем deposit, если есть такой метод
  const depositKey = Object.keys(allMethods).find((k) =>
    /^(account|vault|deposit)\.deposit$/i.test(k) || k === 'deposit.deposit'
  );

  if (depositKey) {
    log(`  Найден метод депозита: ${depositKey}`);
    log(`  ⚠️  Автодепозит отключён — сделайте вручную через app.nado.fi`);
  }

  return true;
}

/* ═══════════ BOT ═══════════ */

async function runBot() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    log('⛔ PRIVATE_KEY не задан → Railway → Variables');
    process.exit(1);
  }

  const { client, account } = getNadoClient(privateKey);
  const address = account.address;

  const defaultAppendix = String(
    packOrderAppendix({ orderExecutionType: 'default' })
  );

  /* ── deposit check ── */
  await ensureDeposit(client, address);

  /* ── state ── */
  const lastBidAsk = new Map();
  let tickCount = 0;
  let orderOk   = 0;
  let orderFail = 0;
  let currentTickMs = TICK_MS;   // адаптивный интервал
  let consecutive429 = 0;

  /* ── fetch prices (с защитой от 429) ── */
  async function fetchPrices() {
    try {
      const result = await client.market.getLatestMarketPrices({
        productIds: PRODUCT_IDS,
      });

      consecutive429 = 0; // сброс при успехе
      currentTickMs = TICK_MS;

      const prices = result?.marketPrices ?? result?.prices ?? [];

      if (!Array.isArray(prices) || prices.length === 0) {
        log(`⚠️ Пустой ответ цен: ${JSON.stringify(result).slice(0, 200)}`);
        return false;
      }

      for (const mp of prices) {
        const bid = toNum(mp.bid);
        const ask = toNum(mp.ask);
        if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
          lastBidAsk.set(mp.productId, { bid, ask, mid: (bid + ask) / 2 });
        }
      }
      return true;
    } catch (e) {
      if (is429(e)) {
        consecutive429++;
        currentTickMs = Math.min(currentTickMs * BACKOFF_MULT, MAX_TICK_MS);
        log(`⚠️ 429 Rate Limit (#${consecutive429}). Пауза → ${currentTickMs / 1000}с`);
      } else {
        err('fetchPrices', e);
      }
      return false;
    }
  }

  /* ── tick ── */
  async function runTick() {
    tickCount++;

    const gotPrices = await fetchPrices();
    if (!gotPrices) return; // не шлём ордера если цен нет

    await sleep(300); // пауза между вызовами API

    const exp = String(Math.floor(Date.now() / 1000) + 86400);

    // cancel
    try {
      await client.market.cancelProductOrders({ productIds: PRODUCT_IDS });
    } catch (e) {
      if (is429(e)) {
        currentTickMs = Math.min(currentTickMs * BACKOFF_MULT, MAX_TICK_MS);
        log(`⚠️ 429 на cancel. Пауза → ${currentTickMs / 1000}с`);
        return;
      }
      if (tickCount <= 5) err('cancelOrders', e);
    }

    for (const productId of PRODUCT_IDS) {
      const book = lastBidAsk.get(productId);
      if (!book || !Number.isFinite(book.mid) || book.mid <= 0) continue;

      const buyPrice  = (Math.floor(book.mid * (1 - SPREAD_PCT) * 1e6) / 1e6).toFixed(6);
      const sellPrice = (Math.ceil(book.mid * (1 + SPREAD_PCT) * 1e6) / 1e6).toFixed(6);

      await sleep(200); // пауза между ордерами

      // BUY
      try {
        const res = await client.market.placeOrder({
          productId,
          order: {
            price: buyPrice,
            amount: ORDER_SIZE,
            expiration: exp,
            appendix: defaultAppendix,
          },
        });
        orderOk++;
        if (tickCount <= 10 || tickCount % 50 === 0) {
          log(`✅ BUY  pid=${productId} @ ${buyPrice}`);
        }
      } catch (e) {
        orderFail++;
        if (is429(e)) {
          currentTickMs = Math.min(currentTickMs * BACKOFF_MULT, MAX_TICK_MS);
          log(`⚠️ 429 на BUY. Пауза → ${currentTickMs / 1000}с`);
          return;
        }
        // Логируем первые 20 ошибок + каждую 50-ю
        if (orderFail <= 20 || orderFail % 50 === 0) {
          err(`BUY pid=${productId}`, e);
        }
      }

      await sleep(200);

      // SELL
      try {
        const res = await client.market.placeOrder({
          productId,
          order: {
            price: sellPrice,
            amount: String(-Number(ORDER_SIZE)),
            expiration: exp,
            appendix: defaultAppendix,
          },
        });
        orderOk++;
        if (tickCount <= 10 || tickCount % 50 === 0) {
          log(`✅ SELL pid=${productId} @ ${sellPrice}`);
        }
      } catch (e) {
        orderFail++;
        if (is429(e)) {
          currentTickMs = Math.min(currentTickMs * BACKOFF_MULT, MAX_TICK_MS);
          log(`⚠️ 429 на SELL. Пауза → ${currentTickMs / 1000}с`);
          return;
        }
        if (orderFail <= 20 || orderFail % 50 === 0) {
          err(`SELL pid=${productId}`, e);
        }
      }
    }
  }

  /* ── adaptive loop (вместо setInterval) ── */
  async function loop() {
    while (true) {
      try {
        await runTick();
      } catch (e) {
        err('runTick', e);
      }
      await sleep(currentTickMs);
    }
  }

  /* ── start ── */
  log('');
  log('╔══════════════════════════════════════════════╗');
  log('║  Nado Market Maker Bot                       ║');
  log('╠══════════════════════════════════════════════╣');
  log(`║  Tick interval: ${TICK_MS / 1000}s (adaptive up to ${MAX_TICK_MS / 1000}s)    ║`);
  log(`║  Products: ${PRODUCT_IDS.join(', ')}                           ║`);
  log(`║  Order size: ${ORDER_SIZE}                            ║`);
  log(`║  Spread: ${(SPREAD_PCT * 100).toFixed(3)}%                          ║`);
  log('╚══════════════════════════════════════════════╝');
  log('');

  // Первый fetch
  const ok = await fetchPrices();
  if (ok) {
    for (const [pid, v] of lastBidAsk) {
      log(`  pid=${pid}: bid=${v.bid} ask=${v.ask} mid=${v.mid.toFixed(2)}`);
    }
  } else {
    log('⚠️ Первый fetch не удался — бот продолжит пробовать');
  }

  // Мониторинг
  setInterval(() => {
    const mids = Array.from(lastBidAsk.entries())
      .map(([pid, v]) => `pid${pid}=${v.mid.toFixed(2)}`)
      .join(' | ');
    log(`📊 ${mids || '—'} | tick=${currentTickMs / 1000}s | ticks=${tickCount} ok=${orderOk} fail=${orderFail}`);
  }, LOG_INTERVAL);

  // Основной цикл
  loop();
}

runBot().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});