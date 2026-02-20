require('dotenv').config();
const { createPublicClient, createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const {
  createNadoClient,
  CHAIN_ENV_TO_CHAIN,
  packOrderAppendix,
} = require('@nadohq/client');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function diagnose() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    log('⛔ PRIVATE_KEY не задан');
    process.exit(1);
  }

  const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(pk);

  log('');
  log('╔═══════════════════════════════════════════════════╗');
  log('║           NADO BOT — ДИАГНОСТИКА АДРЕСА          ║');
  log('╚═══════════════════════════════════════════════════╝');
  log('');
  log(`🔑 Адрес из PRIVATE_KEY: ${account.address}`);
  log('');
  log('⬆️  СРАВНИТЕ этот адрес с адресом в app.nado.fi!');
  log('   Откройте app.nado.fi → подключите кошелёк →');
  log('   скопируйте адрес → должен быть ИДЕНТИЧЕН.');
  log('');

  // Создаём клиент
  const chainConfig = CHAIN_ENV_TO_CHAIN.inkMainnet;
  const publicClient = createPublicClient({ chain: chainConfig, transport: http() });
  const walletClient = createWalletClient({ account, chain: chainConfig, transport: http() });
  const client = createNadoClient('inkMainnet', { publicClient, walletClient });

  // Дампим ВСЕ методы SDK
  log('── Все методы SDK ──');
  const allMethods = [];
  for (const ns of Object.keys(client)) {
    if (typeof client[ns] !== 'object' || client[ns] === null) continue;
    for (const m of Object.keys(client[ns])) {
      if (typeof client[ns][m] === 'function') {
        allMethods.push(`${ns}.${m}`);
      }
    }
  }
  log(allMethods.join('\n'));
  log('');

  // Пробуем ВСЕ методы которые могут вернуть инфу об аккаунте
  log('── Пробуем методы аккаунта/баланса ──');

  for (const fullName of allMethods) {
    if (!/account|balance|deposit|portfolio|collateral|margin|info|user|trader|position/i.test(fullName)) {
      continue;
    }

    const [ns, m] = fullName.split('.');

    // Пробуем разные варианты параметров
    const paramVariants = [
      { address: account.address },
      { account: account.address },
      { trader: account.address },
      { user: account.address },
      { owner: account.address },
      {},
    ];

    for (const params of paramVariants) {
      try {
        const res = await client[ns][m](params);
        const dump = JSON.stringify(res, (_, v) =>
          typeof v === 'bigint' ? v.toString() : v
        ).slice(0, 600);
        log(`✅ ${fullName}(${JSON.stringify(params)}) →`);
        log(`   ${dump}`);
        log('');
        break; // нашли рабочий вариант
      } catch (e) {
        const msg = e?.message || '';
        // Пропускаем «не те параметры» молча, но логируем содержательные ошибки
        if (msg.includes('no previous deposits') || msg.includes('2024')) {
          log(`❌ ${fullName}(${JSON.stringify(params)}) → NO DEPOSITS`);
          break;
        }
      }
    }

    // Пауза чтобы не словить 429
    await new Promise((r) => setTimeout(r, 1000));
  }

  log('');
  log('── Проверяю context клиента ──');
  
  // Проверяем что лежит в context
  if (client.context) {
    const ctx = client.context;
    log(`context.walletClient.account.address: ${ctx.walletClient?.account?.address}`);
    
    // Может быть sub-account
    if (ctx.account) {
      log(`context.account: ${JSON.stringify(ctx.account, (_, v) => typeof v === 'bigint' ? v.toString() : v).slice(0, 300)}`);
    }
    if (ctx.subAccount || ctx.subaccount) {
      log(`context.subAccount: ${ctx.subAccount || ctx.subaccount}`);
    }

    // Дампим весь context
    const ctxKeys = Object.keys(ctx);
    log(`context keys: [${ctxKeys.join(', ')}]`);
    
    for (const k of ctxKeys) {
      if (typeof ctx[k] === 'string' || typeof ctx[k] === 'number') {
        log(`  context.${k} = ${ctx[k]}`);
      }
    }
  }

  log('');
  log('── Тестовый ордер (для диагностики ошибки) ──');

  try {
    const { marketPrices } = await client.market.getLatestMarketPrices({
      productIds: [1],
    });

    const bid = Number(marketPrices[0]?.bid || 0);
    const ask = Number(marketPrices[0]?.ask || 0);
    const mid = (bid + ask) / 2;

    if (mid > 0) {
      const price = (Math.floor(mid * 0.999 * 100) / 100).toFixed(6);
      const appendix = String(packOrderAppendix({ orderExecutionType: 'default' }));
      const exp = String(Math.floor(Date.now() / 1000) + 86400);

      log(`Пробую BUY pid=1 price=${price} amount=1 ...`);

      const res = await client.market.placeOrder({
        productId: 1,
        order: {
          price,
          amount: '1',
          expiration: exp,
          appendix,
        },
      });

      log(`✅ Ордер прошёл! ${JSON.stringify(res).slice(0, 300)}`);
    }
  } catch (e) {
    const msg = e?.message || String(e);
    log(`❌ Тестовый ордер: ${msg.slice(0, 500)}`);

    // Если 2024 — точно не тот адрес
    if (msg.includes('2024') || msg.includes('no previous deposits')) {
      log('');
      log('╔═══════════════════════════════════════════════════╗');
      log('║  ⛔ ВЕРДИКТ: АДРЕС НЕ СОВПАДАЕТ С ДЕПОЗИТОМ     ║');
      log('╠═══════════════════════════════════════════════════╣');
      log(`║  Бот использует:  ${account.address}  ║`);
      log('║                                                   ║');
      log('║  Что делать:                                      ║');
      log('║  1) Откройте app.nado.fi                          ║');
      log('║  2) Подключите кошелёк                            ║');
      log('║  3) Скопируйте адрес из интерфейса                ║');
      log('║  4) Сравните с адресом выше                        ║');
      log('║                                                   ║');
      log('║  Варианты:                                        ║');
      log('║  A) Адреса разные → замените PRIVATE_KEY          ║');
      log('║     в Railway на ключ от правильного кошелька      ║');
      log('║                                                   ║');
      log('║  B) Адреса одинаковые → Nado использует            ║');
      log('║     sub-account (смарт-контракт), а SDK             ║');
      log('║     шлёт от EOA. Нужно найти метод                ║');
      log('║     registerSubAccount или deposit в SDK.          ║');
      log('╚═══════════════════════════════════════════════════╝');
    }
  }

  log('');
  log('Диагностика завершена. Проверьте вывод выше.');
}

diagnose().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});