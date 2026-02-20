require('dotenv').config();
const {
  createPublicClient, createWalletClient, http,
  formatUnits, parseUnits, getContract, maxUint256,
} = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const {
  createNadoClient,
  CHAIN_ENV_TO_CHAIN,
  packOrderAppendix,
} = require('@nadohq/client');

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══ ABI ═══
const erc20Abi = [
  { name: 'symbol',    type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'name',      type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals',  type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve',   type: 'function', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];

// Vertex-style deposit — Nado это форк Vertex
const endpointAbi = [
  {
    name: 'depositCollateral',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'subaccountName', type: 'bytes12' },
      { name: 'productId',     type: 'uint32'  },
      { name: 'amount',        type: 'uint128' },
    ],
    outputs: [],
  },
  {
    name: 'getQuote',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
];

// ═══ CONFIG ═══
const ENDPOINT_ADDR = '0x05ec92D78ED421f3D3Ada77FFdE167106565974E';
const USDT0_ADDR    = '0x0200C29006150606B650577BBE7B6248F58470c1';
const PRODUCT_IDS   = [1, 2];
const SPREAD_PCT    = 0.00015;
const ORDER_SIZE    = '15';
const TICK_MS       = 5000;
const MAX_TICK_MS   = 60000;

// "default" в bytes12 = 0x64656661756c740000000000
const DEFAULT_SUBACCOUNT = '0x64656661756c740000000000';

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) { log('⛔ PRIVATE_KEY not set'); process.exit(1); }

  const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const account     = privateKeyToAccount(pk);
  const chainConfig = CHAIN_ENV_TO_CHAIN.inkMainnet;
  const publicClient  = createPublicClient({ chain: chainConfig, transport: http() });
  const walletClient  = createWalletClient({ account, chain: chainConfig, transport: http() });
  const nadoClient    = createNadoClient('inkMainnet', { publicClient, walletClient });

  log('════════════════════════════════════════════');
  log(`  Кошелёк: ${account.address}`);
  log('════════════════════════════════════════════');

  // ═══ 1. ПРОВЕРЯЕМ USDT0 ═══
  log('');
  log('═══ 1. БАЛАНС USDT0 ═══');

  const usdt0 = getContract({
    address: USDT0_ADDR,
    abi: erc20Abi,
    client: { public: publicClient, wallet: walletClient },
  });

  let symbol, decimals, balance, allowance;
  try {
    [symbol, decimals, balance, allowance] = await Promise.all([
      usdt0.read.symbol(),
      usdt0.read.decimals(),
      usdt0.read.balanceOf([account.address]),
      usdt0.read.allowance([account.address, ENDPOINT_ADDR]),
    ]);

    const name = await usdt0.read.name().catch(() => '???');

    log(`  Токен:     ${name} (${symbol})`);
    log(`  Decimals:  ${decimals}`);
    log(`  Баланс:    ${formatUnits(balance, decimals)} ${symbol}`);
    log(`  Allowance: ${formatUnits(allowance, decimals)} → Endpoint`);
  } catch (e) {
    log(`  ❌ Не могу прочитать USDT0: ${e.message?.slice(0, 200)}`);
    log('  Пробую продолжить...');
    decimals = 6;
    balance = 0n;
    allowance = 0n;
    symbol = 'USDT0';
  }

  // ═══ 2. APPROVE + DEPOSIT если есть баланс ═══
  if (balance > 0n) {
    log('');
    log('═══ 2. APPROVE + DEPOSIT ═══');

    // Approve если нужно
    if (allowance < balance) {
      log(`  Approve ${symbol} для Endpoint...`);
      try {
        const hash = await usdt0.write.approve([ENDPOINT_ADDR, maxUint256]);
        log(`  ✅ Approve tx: ${hash}`);
        log('  Ждём подтверждения...');
        await publicClient.waitForTransactionReceipt({ hash });
        log('  ✅ Approve подтверждён');
      } catch (e) {
        log(`  ❌ Approve failed: ${e.message?.slice(0, 300)}`);
        log('  Пробую депозит без нового approve...');
      }
      await sleep(2000);
    } else {
      log('  Approve уже есть ✅');
    }

    // Deposit
    log(`  Deposit ${formatUnits(balance, decimals)} ${symbol} в Nado...`);

    const endpoint = getContract({
      address: ENDPOINT_ADDR,
      abi: endpointAbi,
      client: { public: publicClient, wallet: walletClient },
    });

    try {
      const hash = await endpoint.write.depositCollateral([
        DEFAULT_SUBACCOUNT,  // bytes12 "default"
        0,                   // productId 0 = quote token
        balance,             // весь баланс
      ]);
      log(`  ✅ Deposit tx: ${hash}`);
      log('  Ждём подтверждения...');
      await publicClient.waitForTransactionReceipt({ hash });
      log('  ✅ Deposit подтверждён!');
    } catch (e) {
      const msg = e.message || '';
      log(`  ❌ Deposit failed: ${msg.slice(0, 400)}`);

      // Пробуем другой вариант subaccount name
      if (msg.includes('revert') || msg.includes('execution')) {
        log('  Пробую другие варианты subaccount name...');

        const subaccountVariants = [
          '0x000000000000000000000000',  // пустое имя
          '0x6d61696e0000000000000000',  // "main"
          '0x747261646500000000000000',  // "trade"
        ];

        for (const sub of subaccountVariants) {
          try {
            log(`    Пробую subaccount: ${sub}`);
            const hash = await endpoint.write.depositCollateral([
              sub, 0, balance,
            ]);
            log(`    ✅ Deposit tx: ${hash}`);
            await publicClient.waitForTransactionReceipt({ hash });
            log('    ✅ Deposit подтверждён!');
            break;
          } catch (e2) {
            log(`    ❌ ${e2.message?.slice(0, 150)}`);
          }
        }
      }
    }

    // Проверяем результат
    await sleep(3000);
    const newBal = await usdt0.read.balanceOf([account.address]);
    log(`  Баланс ${symbol} после депозита: ${formatUnits(newBal, decimals)}`);

  } else {
    log('');
    log('  ⚠️  Баланс USDT0 = 0');
    log('  Два варианта:');
    log('  A) Депозит уже сделан → пробуем торговать');
    log('  B) Нет средств → пополните USDT0 на Ink chain');
    log('     и перезапустите бота');
  }

  // ═══ 3. ТЕСТОВЫЙ ОРДЕР ═══
  log('');
  log('═══ 3. ТЕСТОВЫЙ ОРДЕР ═══');

  await sleep(2000);

  try {
    const { marketPrices } = await nadoClient.market.getLatestMarketPrices({
      productIds: [1],
    });

    const bid = Number(marketPrices[0]?.bid || 0);
    const ask = Number(marketPrices[0]?.ask || 0);
    const mid = (bid + ask) / 2;

    if (mid > 0) {
      const price = (Math.floor(mid * 0.999 * 100) / 100).toFixed(6);
      const appendix = String(packOrderAppendix({ orderExecutionType: 'default' }));
      const exp = String(Math.floor(Date.now() / 1000) + 86400);

      log(`  mid=${mid.toFixed(2)} → тестовый BUY @ ${price}`);

      const res = await nadoClient.market.placeOrder({
        productId: 1,
        order: { price, amount: '1', expiration: exp, appendix },
      });
      log(`  ✅ ОРДЕР ПРОШЁЛ! ${JSON.stringify(res).slice(0, 200)}`);
      log('  → Депозит работает, запускаю бота!');

      // Cancel тестовый
      await sleep(1000);
      await nadoClient.market.cancelProductOrders({ productIds: [1] }).catch(() => {});
    }
  } catch (e) {
    const msg = e.message || '';
    log(`  ❌ Тестовый ордер: ${msg.slice(0, 300)}`);

    if (msg.includes('no previous deposits') || msg.includes('2024')) {
      log('');
      log('  ⛔ Всё ещё "no deposits". Возможные причины:');
      log('  1. Депозит ещё не обработан — подождите 1-2 минуты');
      log('  2. Нужно депозитить через app.nado.fi вручную');
      log('  3. Приватный ключ от другого аккаунта MetaMask');
      log('');
      log('  Бот подождёт 60 сек и попробует снова...');
      await sleep(60000);
    }
  }

  // ═══ 4. МАРКЕТМЕЙКЕР ═══
  log('');
  log('═══ 4. ЗАПУСК МАРКЕТМЕЙКЕРА ═══');

  const defaultAppendix = String(packOrderAppendix({ orderExecutionType: 'default' }));
  const lastBidAsk = new Map();
  let tickCount = 0, orderOk = 0, orderFail = 0;
  let currentTickMs = TICK_MS;

  function is429(e) {
    return (e?.message || '').includes('429') || (e?.message || '').includes('cf_chl');
  }

  function toNum(v) {
    if (v == null) return 0;
    if (typeof v === 'bigint') return Number(v);
    return Number(v);
  }

  async function fetchPrices() {
    try {
      const { marketPrices } = await nadoClient.market.getLatestMarketPrices({
        productIds: PRODUCT_IDS,
      });
      for (const mp of marketPrices) {
        const bid = toNum(mp.bid);
        const ask = toNum(mp.ask);
        if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) {
          lastBidAsk.set(mp.productId, { bid, ask, mid: (bid + ask) / 2 });
        }
      }
      currentTickMs = TICK_MS;
      return true;
    } catch (e) {
      if (is429(e)) {
        currentTickMs = Math.min(currentTickMs * 2, MAX_TICK_MS);
        log(`⚠️ 429 → пауза ${currentTickMs / 1000}с`);
      } else {
        log(`❌ fetchPrices: ${(e.message || '').slice(0, 150)}`);
      }
      return false;
    }
  }

  async function runTick() {
    tickCount++;
    if (!await fetchPrices()) return;
    await sleep(300);

    const exp = String(Math.floor(Date.now() / 1000) + 86400);

    try {
      await nadoClient.market.cancelProductOrders({ productIds: PRODUCT_IDS });
    } catch (e) {
      if (is429(e)) { currentTickMs = Math.min(currentTickMs * 2, MAX_TICK_MS); return; }
    }

    for (const productId of PRODUCT_IDS) {
      const book = lastBidAsk.get(productId);
      if (!book || book.mid <= 0) continue;

      const buyPrice  = (Math.floor(book.mid * (1 - SPREAD_PCT) * 1e6) / 1e6).toFixed(6);
      const sellPrice = (Math.ceil(book.mid * (1 + SPREAD_PCT) * 1e6) / 1e6).toFixed(6);

      await sleep(200);

      try {
        await nadoClient.market.placeOrder({
          productId,
          order: { price: buyPrice, amount: ORDER_SIZE, expiration: exp, appendix: defaultAppendix },
        });
        orderOk++;
        if (tickCount <= 5) log(`✅ BUY  pid=${productId} @ ${buyPrice}`);
      } catch (e) {
        orderFail++;
        if (is429(e)) { currentTickMs = Math.min(currentTickMs * 2, MAX_TICK_MS); return; }
        if (orderFail <= 10) log(`❌ BUY pid=${productId}: ${(e.message || '').slice(0, 150)}`);
      }

      await sleep(200);

      try {
        await nadoClient.market.placeOrder({
          productId,
          order: { price: sellPrice, amount: String(-Number(ORDER_SIZE)), expiration: exp, appendix: defaultAppendix },
        });
        orderOk++;
        if (tickCount <= 5) log(`✅ SELL pid=${productId} @ ${sellPrice}`);
      } catch (e) {
        orderFail++;
        if (is429(e)) { currentTickMs = Math.min(currentTickMs * 2, MAX_TICK_MS); return; }
        if (orderFail <= 10) log(`❌ SELL pid=${productId}: ${(e.message || '').slice(0, 150)}`);
      }
    }
  }

  log(`Тик: ${TICK_MS / 1000}с (адаптивный до ${MAX_TICK_MS / 1000}с)`);

  // Основной цикл
  async function loop() {
    while (true) {
      try { await runTick(); } catch (e) { log(`❌ tick: ${e.message?.slice(0, 150)}`); }
      await sleep(currentTickMs);
    }
  }

  setInterval(() => {
    const mids = Array.from(lastBidAsk.entries())
      .map(([p, v]) => `pid${p}=${v.mid.toFixed(2)}`)
      .join(' | ');
    log(`📊 ${mids || '—'} | tick=${currentTickMs / 1000}s ok=${orderOk} fail=${orderFail}`);
  }, 60000);

  loop();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });