// analysis.js
// Physics Momentum analyzer + multi-source candle loader + helper check for TP/SL
// Trả về object signal khi detect (entry, tp, sl, rr, side, confidence)
// Cũng export checkSignalHit để monitor signal (kiểm tra nếu TP/SL đã bị chạm trong nến 1m)

const axios = require('axios');

const DATA_SOURCES = [
    {
        name: 'Binance Main',
        klines: (symbol, interval, limit = 500) =>
            `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
        priority: 1
    },
    {
        name: 'Binance Futures (fapi) fallback',
        klines: (symbol, interval, limit = 500) =>
            `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
        priority: 2
    },
    {
        name: 'Bybit Backup',
        klines: (symbol, interval, limit = 500) => {
            // Bybit v5 mapping
            const mapping = { '1m': '1', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
            const intv = mapping[interval] || mapping['1m'];
            return `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${intv}&limit=${limit}`;
        },
        priority: 3
    }
];

// Physics Momentum parameters
const RSI_LENGTH = 14;
const BB_LENGTH = 20;
const BB_STD = 2;
const V_SMA = 3; // velocity SMA length
const ATR_LENGTH = 14;

const fetchTimeout = 10000; // ms

async function loadCandles(symbol, interval = '5m', limit = 120) {
    // Try sources in order of priority; shuffle only if you want random rotation.
    const sources = DATA_SOURCES.slice().sort((a, b) => a.priority - b.priority);

    for (const source of sources) {
        try {
            const url = source.klines(symbol, interval, limit);
            const res = await axios.get(url, {
                timeout: fetchTimeout,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; NemesisBot/1.0)',
                    'Accept': 'application/json'
                }
            });

            if (res.status !== 200 || !res.data) {
                continue;
            }

            let raw = res.data;

            // Normalize formats
            let candles = [];
            if (source.name.includes('Bybit')) {
                // Bybit structure: response.data.result.list (may vary)
                const list = raw?.result?.list || raw?.result?.data || raw;
                if (!list) throw new Error('Invalid Bybit response format');
                // bybit list might be newest-first; ensure consistent mapping
                // We map into array of { t, open, high, low, close, vol } in ascending time
                const mapped = list.map(item => {
                    // item structure might be [t, open, high, low, close, vol] OR object - try both
                    if (Array.isArray(item)) {
                        return {
                            t: parseInt(item[0]),
                            open: parseFloat(item[1]),
                            high: parseFloat(item[2]),
                            low: parseFloat(item[3]),
                            close: parseFloat(item[4]),
                            vol: parseFloat(item[5] || 0)
                        };
                    } else {
                        // object with keys
                        return {
                            t: parseInt(item.t || item.start || 0),
                            open: parseFloat(item.o || item.open || 0),
                            high: parseFloat(item.h || item.high || 0),
                            low: parseFloat(item.l || item.low || 0),
                            close: parseFloat(item.c || item.close || 0),
                            vol: parseFloat(item.v || item.volume || 0)
                        };
                    }
                });
                // ensure ascending by time
                candles = mapped.sort((a, b) => a.t - b.t);
            } else {
                // Binance style: array of arrays [openTime, open, high, low, close, volume, ...]
                if (!Array.isArray(raw)) throw new Error('Invalid Binance response format');
                candles = raw.map(item => ({
                    t: parseInt(item[0]),
                    open: parseFloat(item[1]),
                    high: parseFloat(item[2]),
                    low: parseFloat(item[3]),
                    close: parseFloat(item[4]),
                    vol: parseFloat(item[5] || 0)
                }));
            }

            if (candles.length === 0) continue;
            return candles;
        } catch (err) {
            // Log and continue to next source
            console.log(`❌ ${source.name} failed for ${symbol} ${interval}: ${err?.response?.status || err.code || err.message}`);
            // If rate-limited, small backoff
            if (err?.response?.status === 418 || err?.response?.status === 429) {
                await new Promise(r => setTimeout(r, 3000));
            }
            continue;
        }
    }

    throw new Error(`All data sources failed for ${symbol} ${interval}`);
}

// Helpers: simple RSI, SMA, ATR implementations on arrays
function rsiFromCloses(closes, length = 14) {
    // returns array of RSI values aligned with closes (NaN for first)
    const res = new Array(closes.length).fill(NaN);
    if (closes.length < length + 1) return res;
    // compute deltas
    const deltas = [];
    for (let i = 1; i < closes.length; i++) deltas.push(closes[i] - closes[i - 1]);
    // initial avg gain/loss
    let gains = 0, losses = 0;
    for (let i = 0; i < length; i++) {
        const d = deltas[i];
        if (d > 0) gains += d; else losses += Math.abs(d);
    }
    let avgGain = gains / length;
    let avgLoss = losses / length;
    let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    res[length] = 100 - (100 / (1 + rs));
    for (let i = length + 1; i < closes.length; i++) {
        const d = deltas[i - 1];
        const gain = d > 0 ? d : 0;
        const loss = d < 0 ? Math.abs(d) : 0;
        avgGain = (avgGain * (length - 1) + gain) / length;
        avgLoss = (avgLoss * (length - 1) + loss) / length;
        rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        res[i] = 100 - (100 / (1 + rs));
    }
    return res;
}

function sma(values, period) {
    const out = new Array(values.length).fill(NaN);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i] || 0;
        if (i >= period) sum -= values[i - period] || 0;
        if (i >= period - 1) out[i] = sum / period;
    }
    return out;
}

function atrFromCandles(candles, period = 14) {
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const cur = candles[i];
        const prev = candles[i - 1];
        const tr = Math.max(
            cur.high - cur.low,
            Math.abs(cur.high - prev.close),
            Math.abs(cur.low - prev.close)
        );
        trs.push(tr);
    }
    if (trs.length < period) return new Array(candles.length).fill(NaN);
    const out = new Array(candles.length).fill(NaN);
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    out[period] = atr;
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
        out[i + 1] = atr; // offset by 1 due to trs indexing
    }
    return out;
}

// Main Physics Momentum analyzer
async function analyzeSymbol(symbol) {
    try {
        const ohlcv = await loadCandles(symbol, '5m', 200);
        if (!ohlcv || ohlcv.length < 30) {
            return null;
        }

        const closes = ohlcv.map(c => c.close);
        const highs = ohlcv.map(c => c.high);
        const lows = ohlcv.map(c => c.low);

        // RSI
        const rsiArr = rsiFromCloses(closes, RSI_LENGTH);

        // Bollinger Bands - simple implementation using SMA & stdDev
        const sma20 = sma(closes, BB_LENGTH);
        const bb_upper = new Array(closes.length).fill(NaN);
        const bb_lower = new Array(closes.length).fill(NaN);
        for (let i = BB_LENGTH - 1; i < closes.length; i++) {
            const slice = closes.slice(i - BB_LENGTH + 1, i + 1);
            const mean = sma20[i];
            let variance = 0;
            for (const v of slice) variance += Math.pow(v - mean, 2);
            variance /= BB_LENGTH;
            const std = Math.sqrt(variance);
            bb_upper[i] = mean + BB_STD * std;
            bb_lower[i] = mean - BB_STD * std;
        }

        // Velocity v = SMA(3) of price change
        const priceChange = new Array(closes.length).fill(0);
        for (let i = 1; i < closes.length; i++) priceChange[i] = closes[i] - closes[i - 1];
        const vArr = sma(priceChange, V_SMA);

        // Acceleration a = v_t - v_{t-1}
        const aArr = new Array(vArr.length).fill(NaN);
        for (let i = 1; i < vArr.length; i++) {
            if (!isNaN(vArr[i]) && !isNaN(vArr[i - 1])) aArr[i] = vArr[i] - vArr[i - 1];
        }

        // ATR
        const atrArr = atrFromCandles(ohlcv, ATR_LENGTH);

        const i = closes.length - 1;
        const rsi = rsiArr[i];
        const close = closes[i];
        const lowerBB = bb_lower[i];
        const upperBB = bb_upper[i];
        const acc = aArr[i];
        const atr = atrArr[i];

        if ([rsi, lowerBB, upperBB, acc, atr].some(v => v === undefined || v === null || isNaN(v))) {
            return null;
        }

        // Entry rules
        let side = null;
        if (rsi < 30 && close < lowerBB && acc > 0) side = 'LONG';
        else if (rsi > 70 && close > upperBB && acc < 0) side = 'SHORT';
        else return null;

        const entry = close;
        let sl, tp;
        if (side === 'LONG') {
            sl = entry - 1.5 * atr;
            tp = entry + 3.0 * atr;
        } else {
            sl = entry + 1.5 * atr;
            tp = entry - 3.0 * atr;
        }

        const rr = Math.abs(tp - entry) / Math.abs(entry - sl);
        const confidence = 60 + Math.min(35, Math.max(0, (Math.abs(acc) / (Math.abs(atr) || 1)) * 10)); // heuristic

        return {
            symbol,
            side,
            entry: parseFloat(entry.toFixed(8)),
            sl: parseFloat(sl.toFixed(8)),
            tp: parseFloat(tp.toFixed(8)),
            rr: parseFloat(rr.toFixed(2)),
            confidence: Math.round(Math.min(100, confidence)),
            meta: {
                rsi: parseFloat(rsi.toFixed(2)),
                acc: parseFloat(acc.toFixed(8)),
                atr: parseFloat(atr.toFixed(8)),
                lowerBB: parseFloat(lowerBB.toFixed(8)),
                upperBB: parseFloat(upperBB.toFixed(8)),
                timeframe: '5m'
            }
        };
    } catch (err) {
        console.error(`analysis.analyzeSymbol error for ${symbol}:`, err.message || err);
        return null;
    }
}

// Function for monitor: check if TP/SL hit using 1m candles
// returns { status: 'TP'|'SL' | null, whichCandleIndex: idx (0..n-1), detail: {...} }
async function checkSignalHit(symbol, side, entry, sl, tp, lookbackMinutes = 120) {
    try {
        // load last lookbackMinutes of 1m candles (limit = lookbackMinutes)
        const limit = Math.min(Math.max(lookbackMinutes, 10), 1440); // 10..1440
        const candles = await loadCandles(symbol, '1m', limit);
        if (!candles || candles.length === 0) return { status: null };

        // iterate from old to new, find the earliest candle where SL or TP touched
        for (let idx = 0; idx < candles.length; idx++) {
            const c = candles[idx];
            const high = c.high;
            const low = c.low;
            const open = c.open;
            const close = c.close;

            if (side === 'LONG') {
                const tpTouched = high >= tp;
                const slTouched = low <= sl;
                if (tpTouched && !slTouched) return { status: 'TP', idx, candle: c };
                if (slTouched && !tpTouched) return { status: 'SL', idx, candle: c };
                if (tpTouched && slTouched) {
                    // both touched in same candle - best-effort decide by close price:
                    if (close >= tp) return { status: 'TP', idx, candle: c, note: 'both_in_same_candle, close>=tp => TP' };
                    else return { status: 'SL', idx, candle: c, note: 'both_in_same_candle, close<tp => SL' };
                }
            } else if (side === 'SHORT') {
                const tpTouched = low <= tp;
                const slTouched = high >= sl;
                if (tpTouched && !slTouched) return { status: 'TP', idx, candle: c };
                if (slTouched && !tpTouched) return { status: 'SL', idx, candle: c };
                if (tpTouched && slTouched) {
                    if (close <= tp) return { status: 'TP', idx, candle: c, note: 'both_in_same_candle, close<=tp => TP' };
                    else return { status: 'SL', idx, candle: c, note: 'both_in_same_candle, close>tp => SL' };
                }
            }
        }

        return { status: null };
    } catch (err) {
        console.error(`analysis.checkSignalHit error for ${symbol}:`, err.message || err);
        return { status: null };
    }
}

module.exports = {
    analyzeSymbol,
    checkSignalHit
};
