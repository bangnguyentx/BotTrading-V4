// index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const moment = require('moment-timezone');
const express = require('express');
const analysis = require('./analysis');

// ----- CONFIG -----
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN_HERE';
const PORT = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, 'users.json');
const SIGNALS_FILE = path.join(__dirname, 'signals.json');

// Scan config
const SCAN_INTERVAL_MS = (process.env.SCAN_INTERVAL_MINUTES ? parseInt(process.env.SCAN_INTERVAL_MINUTES) : 90) * 60 * 1000; // default 90 minutes
const PER_COIN_DELAY_MS = 3000; // polite delay between coin scans
const DEDUPE_WINDOW_MINUTES = 60; // don't re-send same symbol+side within 60 minutes
const MONITOR_CHECK_INTERVAL_MS = 60 * 1000; // check active signals every 60s
const MAX_MONITOR_HOURS = 48; // stop monitoring a signal after this many hours (configurable)

// ----- TARGET COINS (50 coins) -----
const TARGET_COINS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','TRXUSDT','LINKUSDT',
  'MATICUSDT','LTCUSDT','ATOMUSDT','ETCUSDT','XLMUSDT','BCHUSDT','FILUSDT','ALGOUSDT','NEARUSDT','UNIUSDT',
  'DOGEUSDT','ZECUSDT','1000PEPEUSDT','ZENUSDT','HYPEUSDT','WIFUSDT','MEMEUSDT','BOMEUSDT','POPCATUSDT','MYROUSDT',
  'HYPERUSDT','TOSHIUSDT','TURBOUSDT','NFPUSDT','PEOPLEUSDT','ARCUSDT','BTCDOMUSDT','DASHUSDT','APTUSDT',
  'ARBUSDT','OPUSDT','SUIUSDT','SEIUSDT','TIAUSDT','INJUSDT','RNDRUSDT','FETUSDT','AGIXUSDT','OCEANUSDT'
];

// ----- In-memory structures (also persisted) -----
let subscribedUsers = new Map(); // chatId -> { chatId, first_name, username, subscribedAt }
let activeSignals = []; // list of signals being monitored

// load users and signals from disk
function loadJSONFile(filePath, defaultValue) {
    try {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), 'utf8');
            return defaultValue;
        }
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw || 'null') || defaultValue;
    } catch (err) {
        console.error(`Error loading ${filePath}:`, err.message);
        return defaultValue;
    }
}

function saveJSONFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error(`Error saving ${filePath}:`, err.message);
    }
}

function loadState() {
    const users = loadJSONFile(USERS_FILE, []);
    users.forEach(u => subscribedUsers.set(u.chatId, u));

    activeSignals = loadJSONFile(SIGNALS_FILE, []);
    // Convert resolvedAt / createdAt strings back to Date objects if needed is optional
    console.log(`Loaded ${subscribedUsers.size} users and ${activeSignals.length} active signals from disk.`);
}

function persistState() {
    try {
        const usersArr = Array.from(subscribedUsers.values());
        saveJSONFile(USERS_FILE, usersArr);
        saveJSONFile(SIGNALS_FILE, activeSignals);
    } catch (err) {
        console.error('persistState error:', err.message);
    }
}

// ----- Telegram bot -----
const bot = new TelegramBot(TELEGRAM_TOKEN, {
    polling: { interval: 300, params: { timeout: 10 } }
});

bot.on('polling_error', (err) => {
    console.error('Polling error:', err?.message || err);
});

// Express keepalive
const app = express();
app.get('/', (req, res) => {
    res.json({ status: 'AI Trading Bot V3 - Nemesis Compatible', users: subscribedUsers.size, activeSignals: activeSignals.length });
});
app.listen(PORT, () => console.log(`Express server listening on port ${PORT}`));

// ----- Helpers -----
function getVNTime() {
    return moment().tz('Asia/Ho_Chi_Minh');
}

function formatSignalMessage(signalObj, signalIndex) {
    // template requested by you
    const dayText = getVNTime().format('dddd').toUpperCase(); // e.g., "WEDNESDAY" but we might want Vietnamese day names:
    const vnDayMap = {
        'Monday':'THỨ HAI','Tuesday':'THỨ BA','Wednesday':'THỨ TƯ','Thursday':'THỨ NĂM','Friday':'THỨ SÁU','Saturday':'THỨ BẢY','Sunday':'CHỦ NHẬT'
    };
    const dayVN = vnDayMap[getVNTime().format('dddd')] || getVNTime().format('dddd');

    const coinShort = signalObj.symbol.replace('USDT', '');
    const side = signalObj.side.toUpperCase();
    const entry = prettyPrice(signalObj.entry);
    const tp = prettyPrice(signalObj.tp);
    const sl = prettyPrice(signalObj.sl);
    const rr = signalObj.rr !== undefined && signalObj.rr !== null ? signalObj.rr : '-';
    const conf = signalObj.confidence !== undefined ? signalObj.confidence : '-';

    const header = `🤖 Tín hiệu [${signalIndex} trong ngày]\n#${coinShort} – [${side}] 📌\n\n`;
    const body = `🔴 Entry: ${entry}\n🆗 Take Profit: ${tp}\n🙅‍♂️ Stop-Loss: ${sl}\n🪙 Tỉ lệ RR: ${rr} (Conf: ${conf}%)\n\n`;
    const footer = `🧠 By Bot [Physics Momentum]\n\n⚠️ Nhất định phải tuân thủ quản lý rủi ro – Đi tối đa 2-3% risk, Bot chỉ để tham khảo, win 3 lệnh nên ngưng`;

    return header + body + footer;
}

function prettyPrice(p) {
    if (p === null || p === undefined || isNaN(p)) return 'N/A';
    const n = Number(p);
    if (n >= 1) return n.toFixed(4);
    if (n >= 0.0001) return n.toFixed(6);
    return n.toFixed(8);
}

async function broadcastToAllUsers(message) {
    let success = 0, fail = 0;
    for (const [chatId, user] of subscribedUsers) {
        try {
            await bot.sendMessage(chatId, message);
            success++;
            await new Promise(r => setTimeout(r, 80));
        } catch (err) {
            fail++;
            console.warn(`Failed to send to ${chatId}: ${err?.response?.statusCode || err.code || err.message}`);
            // if blocked, remove user
            if (err?.response?.statusCode === 403 || (err.code && err.code === 'ETELEGRAM')) {
                subscribedUsers.delete(chatId);
                console.log(`Removed subscriber ${chatId} due to send error.`);
            }
        }
    }
    persistState();
    return { success, fail };
}

// Utility: dedupe - check if same symbol+side sent within last DEDUPE_WINDOW_MINUTES
function isDuplicateSignal(symbol, side) {
    const now = Date.now();
    const windowMs = (DEDUPE_WINDOW_MINUTES || 60) * 60 * 1000;
    // check activeSignals + signals persisted that were created recently
    for (const s of activeSignals) {
        if (s.symbol === symbol && s.side === side) {
            const createdMs = new Date(s.createdAt).getTime();
            if ((now - createdMs) <= windowMs && (s.status === 'OPEN' || s.status === 'PENDING')) {
                return true;
            }
        }
    }
    return false;
}

// Create and register a new signal, start monitoring
function registerSignal(signalObj) {
    try {
        const id = `SIG_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const s = {
            id,
            symbol: signalObj.symbol,
            side: signalObj.side,
            entry: signalObj.entry,
            sl: signalObj.sl,
            tp: signalObj.tp,
            rr: signalObj.rr,
            confidence: signalObj.confidence || 0,
            createdAt: (new Date()).toISOString(),
            status: 'OPEN', // OPEN / TP / SL / EXPIRED
            resolvedAt: null,
            monitorChecks: 0,
            monitorHistory: [] // push check events
        };
        activeSignals.push(s);
        persistState();
        // Start monitor loop for this signal
        startMonitoringSignal(s);
        return s;
    } catch (err) {
        console.error('registerSignal error:', err.message);
        return null;
    }
}

// Monitor one signal until TP/SL hit or expire
function startMonitoringSignal(signal) {
    // Background asynchronous loop that checks every MONITOR_CHECK_INTERVAL_MS
    // We'll use setInterval and keep reference in the signal object for clearing
    try {
        if (signal._monitorInterval) return; // already monitoring

        const maxChecks = Math.ceil((MAX_MONITOR_HOURS * 60 * 1000) / MONITOR_CHECK_INTERVAL_MS);
        signal._monitorInterval = setInterval(async () => {
            try {
                if (signal.status !== 'OPEN') {
                    clearInterval(signal._monitorInterval);
                    delete signal._monitorInterval;
                    persistState();
                    return;
                }
                signal.monitorChecks = (signal.monitorChecks || 0) + 1;

                // call analysis.checkSignalHit
                const result = await analysis.checkSignalHit(signal.symbol, signal.side, signal.entry, signal.sl, signal.tp, 120);
                signal.monitorHistory.push({ checkedAt: (new Date()).toISOString(), resultStatus: result.status || null });

                if (result.status === 'TP' || result.status === 'SL') {
                    signal.status = result.status;
                    signal.resolvedAt = (new Date()).toISOString();
                    persistState();

                    // compute pnl% approx:
                    let pnlPct = 0;
                    if (signal.side === 'LONG') {
                        pnlPct = (( (result.status === 'TP' ? signal.tp : signal.sl) - signal.entry) / signal.entry) * 100;
                    } else {
                        pnlPct = (( signal.entry - (result.status === 'TP' ? signal.tp : signal.sl)) / signal.entry) * 100;
                    }
                    pnlPct = Number(pnlPct.toFixed(2));

                    // Send message about resolved signal
                    const dayVN = moment().tz('Asia/Ho_Chi_Minh').format('dddd');
                    const vnDayMap = {
                      'Monday':'THỨ HAI','Tuesday':'THỨ BA','Wednesday':'THỨ TƯ','Thursday':'THỨ NĂM','Friday':'THỨ SÁU','Saturday':'THỨ BẢY','Sunday':'CHỦ NHẬT'
                    };
                    const dayText = vnDayMap[ moment().tz('Asia/Ho_Chi_Minh').format('dddd') ] || moment().tz('Asia/Ho_Chi_Minh').format('dddd');
                    const msg = `🔔 Kết quả tín hiệu ${dayText}\n#${signal.symbol.replace('USDT','')} – [${signal.side}]\n\n` +
                                `Trạng thái: ${signal.status === 'TP' ? 'WIN ✅' : 'LOSE ❌'}\n` +
                                `Entry: ${prettyPrice(signal.entry)}\n` +
                                `TP: ${prettyPrice(signal.tp)}\n` +
                                `SL: ${prettyPrice(signal.sl)}\n` +
                                `P/L: ${pnlPct}%\n\n` +
                                `🧠 By Bot [Physics Momentum]\n` +
                                `📌 Tín hiệu đã được theo dõi tự động và đã đóng.`;

                    await broadcastToAllUsers(msg);

                    // stop monitor
                    clearInterval(signal._monitorInterval);
                    delete signal._monitorInterval;
                    persistState();
                    return;
                }

                // expire if too many checks
                if (signal.monitorChecks >= maxChecks) {
                    signal.status = 'EXPIRED';
                    signal.resolvedAt = (new Date()).toISOString();
                    persistState();
                    // notify expiration
                    const expireMsg = `⚠️ Tín hiệu #${signal.symbol.replace('USDT','')} (${signal.side}) đã hết thời gian theo dõi (${MAX_MONITOR_HOURS} giờ) và chưa chạm TP/SL.`;
                    await broadcastToAllUsers(expireMsg);
                    clearInterval(signal._monitorInterval);
                    delete signal._monitorInterval;
                    return;
                }
                // otherwise continue monitoring
            } catch (err) {
                console.error('monitorSignal error:', err.message || err);
            }
        }, MONITOR_CHECK_INTERVAL_MS);

    } catch (err) {
        console.error('startMonitoringSignal error:', err.message);
    }
}

// ----- Main auto-analysis loop -----
let signalCountToday = 0;

// run auto analysis
async function runAutoAnalysis() {
    if (TARGET_COINS.length === 0) return;
    console.log(`[${getVNTime().format('YYYY-MM-DD HH:mm')}] Starting auto analysis - scanning ${TARGET_COINS.length} coins`);
    try {
        for (let idx = 0; idx < TARGET_COINS.length; idx++) {
            const coin = TARGET_COINS[idx];
            try {
                // polite delay
                await new Promise(r => setTimeout(r, PER_COIN_DELAY_MS));

                const res = await analysis.analyzeSymbol(coin);
                if (res && res.side && (res.confidence >= 60)) {
                    // dedupe check
                    if (isDuplicateSignal(coin, res.side)) {
                        console.log(`Skip duplicate signal for ${coin} ${res.side} within ${DEDUPE_WINDOW_MINUTES} minutes`);
                        continue;
                    }
                    // register & broadcast
                    signalCountToday++;
                    const sigObj = {
                        symbol: res.symbol,
                        side: res.side,
                        entry: res.entry,
                        sl: res.sl,
                        tp: res.tp,
                        rr: res.rr,
                        confidence: res.confidence
                    };
                    const registered = registerSignal(sigObj);
                    const message = formatSignalMessage(sigObj, signalCountToday);
                    console.log(`Found signal ${coin} ${res.side} (conf ${res.confidence}%) -> broadcasting to ${subscribedUsers.size} users`);
                    await broadcastToAllUsers(message);
                    // small delay after broadcast
                    await new Promise(r => setTimeout(r, 2000));
                } else {
                    // no signal
                    //console.log(`No signal ${coin}`);
                }
            } catch (err) {
                console.error(`Error analyzing ${coin}:`, err.message || err);
            }
        }
        console.log(`[${getVNTime().format('YYYY-MM-DD HH:mm')}] Auto analysis pass completed`);
    } catch (err) {
        console.error('runAutoAnalysis error:', err.message || err);
    } finally {
        persistState();
    }
}

// ----- Bot commands: /start and /stop (no admin required) -----
bot.onText(/\/start/, (msg) => {
    try {
        const chatId = msg.chat.id;
        const user = msg.from || {};
        if (!subscribedUsers.has(chatId)) {
            const obj = { chatId, first_name: user.first_name || '', username: user.username || '', subscribedAt: (new Date()).toISOString() };
            subscribedUsers.set(chatId, obj);
            persistState();
            bot.sendMessage(chatId,
                `👋 Chào ${user.first_name || 'Trader'}!\nBạn đã được đăng ký nhận tín hiệu tự động.\n\n` +
                `⚠️ Bot chỉ gửi tín hiệu tham khảo (Physics Momentum). Tuân thủ quản lý rủi ro 2-3% mỗi lệnh.`
            );
            console.log(`User subscribed: ${chatId} ${user.username || user.first_name}`);
        } else {
            bot.sendMessage(chatId, `Bạn đã đăng ký nhận tín hiệu trước đó. Cảm ơn!`);
        }
    } catch (err) {
        console.error('/start handler error:', err.message || err);
    }
});

bot.onText(/\/stop/, (msg) => {
    try {
        const chatId = msg.chat.id;
        if (subscribedUsers.has(chatId)) {
            subscribedUsers.delete(chatId);
            persistState();
            bot.sendMessage(chatId, '✅ Bạn đã hủy đăng ký nhận tín hiệu. Gõ /start để đăng ký lại.');
            console.log(`User unsubscribed: ${chatId}`);
        } else {
            bot.sendMessage(chatId, 'Bạn chưa đăng ký nhận tín hiệu.');
        }
    } catch (err) {
        console.error('/stop handler error:', err.message || err);
    }
});

// Allow manual analyze of one symbol: /analyze SYMBOL
bot.onText(/\/analyze (.+)/, async (msg, match) => {
    try {
        const chatId = msg.chat.id;
        let symbol = (match[1] || '').trim().toUpperCase();
        if (!symbol.endsWith('USDT')) symbol = symbol + 'USDT';
        await bot.sendMessage(chatId, `⏳ Đang phân tích ${symbol}...`);
        const res = await analysis.analyzeSymbol(symbol);
        if (!res) {
            bot.sendMessage(chatId, `❌ Không tìm thấy tín hiệu cho ${symbol} (hoặc dữ liệu không đủ).`);
            return;
        }
        // show analysis result (even if no signal)
        const out = {
            symbol: res.symbol,
            side: res.side || 'NO_SIGNAL',
            entry: res.entry,
            tp: res.tp,
            sl: res.sl,
            rr: res.rr,
            confidence: res.confidence || 0
        };
        const msgText = `🔍 Kết quả phân tích ${symbol}\n` +
                        `Signal: ${out.side}\n` +
                        `Entry: ${prettyPrice(out.entry)}\nTP: ${prettyPrice(out.tp)}\nSL: ${prettyPrice(out.sl)}\nRR: ${out.rr}\nConfidence: ${out.confidence}%`;
        bot.sendMessage(chatId, msgText);
    } catch (err) {
        console.error('/analyze error:', err.message || err);
    }
});

// Command to list subscribers count
bot.onText(/\/status/, (msg) => {
    try {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId, `👥 Subscribers: ${subscribedUsers.size}\nActive signals: ${activeSignals.length}`);
    } catch (err) {
        console.error('/status error:', err.message || err);
    }
});

// ----- Init -----
loadState();

// restart monitors for active signals loaded from disk
activeSignals.forEach(s => {
    if (s.status === 'OPEN') startMonitoringSignal(s);
});

// schedule auto-analysis at interval (first run after small delay)
setTimeout(() => {
    runAutoAnalysis();
}, 10 * 1000);

setInterval(() => {
    runAutoAnalysis();
}, SCAN_INTERVAL_MS);

console.log('🤖 Nemesis-like Bot started');
console.log(`Auto-scan every ${SCAN_INTERVAL_MS / 60000} minutes for ${TARGET_COINS.length} coins`);
console.log('/start to subscribe, /stop to unsubscribe, /analyze SYMBOL to manual check, /status for counts');

// persist state periodically
setInterval(() => { persistState(); }, 60 * 1000);
