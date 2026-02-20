require('dotenv').config();
const { createPublicClient, createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const {
  createNadoClient,
  CHAIN_ENV_TO_CHAIN,
  packOrderAppendix,
} = require('@nadohq/client');

/* ═══════════ CONFIG ═══════════ */

const PRODUCT_IDS = [1, 2];
const SPREAD_PCT  = 0.00015;
const ORDER_SIZE  = '15';
const TICK_MS     = 200;
const LOG_INTERVAL = 60_000;

/* ═══════════ HELPERS ═══════════ */

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function err(tag, e) {
  const text = e?.shortMessage || e?.message || String(e);
  console.error(`[${new Date().toISOString()}] ❌ ${tag}: ${text}`);
  // если есть детали от SDK — тоже покажем
  if (e?.details) console.error(`   details: ${e.details}`);
  if (e?.cause)   console.error(`   cause:   ${e.cause?.message || e.cause}`);
}

function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  return Number(v);
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

  // Дампим все доступные namespace и методы SDK — один раз при старте
  const namespaces = Object.keys(client).filter(
    (k) => typeof client[k] === 'object' && client[k] !== null
  );
  for (const ns of namespaces) {
    const methods = Object.keys(client[ns]).filter(
      (m) => typeof client[ns][m] === 'function'
    );
    if (methods.length > 0) {
      log(`SDK namespace "${ns}": [${methods.join(', ')}]`);
    }
  }

  return { client, address: account.address };
}

/* ═══════════ BALANCE ═══════════ */

async function discoverAndCheckBalance(client, address) {
  log('── Проверяю баланс ──');

  // Собираем все «похожие» методы из всех namespace
  const candidates = [];

  for (const ns of Object.keys(client)) {
    if (typeof client[ns] !== 'object' || client[ns] === null) continue;
    for (const method of Object.keys(client[ns])) {
      if (typeof client[ns][method] !== 'function') continue;
      if (/balance|account|portfolio|collateral|info|margin|equity/i.test(method)) {
        candidates.push({ ns, method });
      }
    }
  }

  log(`Кандидаты для баланса: ${candidates.map(c => `${c.ns}.${c.method}`).join(', ') || 'НЕТ'}`);

  for (const { ns, method } of candidates) {
    try {
      const res = await client[ns][method]({ address });
      const dump = JSON.stringify(res, (_, v) =>
        typeof v === 'bigint' ? v.toString() : v
      ).slice(0, 500);
      log(`  ${ns}.${method}() → ${dump}`);

      // Пытаемся вытащить число
      const val = toNum(
        res?.balance ?? res?.collateral ?? res?.equity ?? res?.availableBalance ?? res
      );
      if (Number.isFinite(val) && val > 0) {
        log(`✅ Баланс найден: ${val}`);
        return val;
      }
    } catch (e) {
      err(`${ns}.${method}`, e);
    }
  }

  log('⚠️  Баланс не найден автоматически. Пробуем работать — ошибки покажут причину.');
  return null;
}

/* ═══════════ BOT ═══════════ */

async function runBot() {
  /* ── env check ── */
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    log('⛔ PRIVATE_KEY не задан!');
    log('   Railway → Settings → Variables → добавьте PRIVATE_KEY');
    process.exit(1);
  }
  log(`PRIVATE_KEY загружен (${privateKey.length} символов)`);

  /* ── client ── */
  const { client, address } = getNadoClient(privateKey);

  const defaultAppendix = String(
    packOrderAppendix({ orderExecutionType: 'default' })
  );

  /* ── balance ── */
  const balance = await discoverAndCheckBalance(client, address);

  if (balance !== null && balance <= 0) {
    log('⛔ Нулевой баланс. Пополните депозит в app.nado.fi');
    process.exit(1);
  }

  /* ── state ── */
  const lastBidAsk = new Map();
  let tickCount = 0;
  let orderOk = 0;
  let orderFail = 0;

  /* ── prices ── */
  async function fetchPrices() {
    try {
      const result = await client.market.getLatestMarketPrices({
        productIds: PRODUCT_IDS,
      });

      const prices = result?.marketPrices ?? result?.prices ?? [];

      if (!Array.isArray(prices) || prices.length === 0) {
        log(`⚠️  getLatestMarketPrices вернул пустое: ${JSON.stringify(result).slice(0, 300)}`);
        return;
      }

      for (const mp of prices) {
        const bid = toNum(mp.bid);
        const ask = toNum(mp.ask);
        if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
          lastBidAsk.set(mp.productId, { bid, ask, mid: (bid + ask) / 2 });
        }
      }
    } catch (e) {
      err('fetchPrices', e);
    }
  }

  /* ── tick ── */
  async function runTick() {
    tickCount++;
    await fetchPrices();

    const exp = String(Math.floor(Date.now() / 1000) + 86400);

    // cancel
    try {
      await client.market.cancelProductOrders({ productIds: PRODUCT_IDS });
    } catch (e) {
      // Может быть нормой, если ордеров нет
      if (tickCount <= 3) err('cancelOrders', e);
    }

    for (const productId of PRODUCT_IDS) {
      const book = lastBidAsk.get(productId);
      if (!book || !Number.isFinite(book.mid) || book.mid <= 0) {
        if (tickCount <= 5) log(`⚠️  pid=${productId}: нет цены`);
        continue;
      }

      const buyPrice  = (Math.floor(book.mid * (1 - SPREAD_PCT) * 1e6) / 1e6).toFixed(6);
      const sellPrice = (Math.ceil(book.mid * (1 + SPREAD_PCT) * 1e6) / 1e6).toFixed(6);

      // BUY
      try {
        const res = await client.market.placeOrder({
          productId,
          order: {
            price:      buyPrice,
            amount:     ORDER_SIZE,
            expiration: exp,
            appendix:   defaultAppendix,
          },
        });
        orderOk++;
        if (tickCount <= 5) {
          log(`✅ BUY  pid=${productId} @ ${buyPrice} → ${JSON.stringify(res).slice(0, 150)}`);
        }
      } catch (e) {
        orderFail++;
        if (orderFail <= 10 || orderFail % 100 === 0) {
          err(`BUY pid=${productId} @ ${buyPrice}`, e);
        }
      }

      // SELL
      try {
        const res = await client.market.placeOrder({
          productId,
          order: {
            price:      sellPrice,
            amount:     String(-Number(ORDER_SIZE)),
            expiration: exp,
            appendix:   defaultAppendix,
          },
        });
        orderOk++;
        if (tickCount <= 5) {
          log(`✅ SELL pid=${productId} @ ${sellPrice} → ${JSON.stringify(res).slice(0, 150)}`);
        }
      } catch (e) {
        orderFail++;
        if (orderFail <= 10 || orderFail % 100 === 0) {
          err(`SELL pid=${productId} @ ${sellPrice}`, e);
        }
      }
    }
  }

  /* ── start ── */

  log('🚀 Первый fetch цен…');
  await fetchPrices();

  if (lastBidAsk.size === 0) {
    log('⚠️  Цены пустые. Проверьте PRODUCT_IDS и доступность Nado API.');
    log('   Продолжаю — может появиться позже.');
  } else {
    for (const [pid, v] of lastBidAsk) {
      log(`   pid=${pid}: bid=${v.bid} ask=${v.ask} mid=${v.mid.toFixed(2)}`);
    }
  }

  log(`🔄 Запускаю тики каждые ${TICK_MS} мс`);

  setInterval(() => {
    runTick().catch((e) => err('runTick', e));
  }, TICK_MS);

  // Мониторинг
  setInterval(() => {
    const mids = Array.from(lastBidAsk.entries())
      .map(([pid, v]) => `pid${pid}=${v.mid.toFixed(2)}`)
      .join(' | ');
    log(`📊 ${mids || 'нет цен'} | ticks=${tickCount} ok=${orderOk} fail=${orderFail}`);
  }, LOG_INTERVAL);
}

/* ═══════════ ENTRY ═══════════ */

runBot().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});