// server.js - MilkChoco Agent Manager (認証なし / JSON storage / スリープ対策)
const express = require('express');
const path = require('path');
const https = require('https');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

const SELF_URL = process.env.SELF_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost'}`;
const PING_INTERVAL_MS = 7 * 60 * 1000;

// === データ保存先 ===
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'scripts.json');

// === インメモリDB ===
let db = { scripts: [], nextId: 1 };

function loadDB() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            db = JSON.parse(raw);
            console.log(`[db] loaded ${db.scripts.length} scripts`);
        } else {
            console.log('[db] fresh start');
        }
    } catch (e) {
        console.error('[db] load error:', e.message);
    }
}
loadDB();

function saveDB() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
    } catch (e) {
        console.error('[db] save error:', e.message);
    }
}

// === ミドルウェア ===
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// === ダッシュボード ===
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === API: アップロード ===
app.post('/api/upload', (req, res) => {
    const { name, content } = req.body;
    if (!name || !content) return res.status(400).json({ error: "name and content required" });

    db.scripts.forEach(s => s.is_active = false);

    const script = {
        id: db.nextId++,
        name,
        content,
        size: Buffer.byteLength(content, 'utf8'),
        is_active: true,
        created: new Date().toISOString()
    };
    db.scripts.unshift(script);
    saveDB();

    console.log(`[upload] id=${script.id} name=${name} size=${script.size}`);
    res.json({ ok: true, id: script.id });
});

// === API: 一覧 ===
app.get('/api/list', (req, res) => {
    res.json({ scripts: db.scripts.map(s => ({
        id: s.id, name: s.name, size: s.size,
        is_active: s.is_active, created: s.created
    }))});
});

// === API: アクティブ切替 ===
app.post('/api/activate/:id', (req, res) => {
    const id = parseInt(req.params.id);
    db.scripts.forEach(s => s.is_active = (s.id === id));
    saveDB();
    console.log(`[activate] id=${id}`);
    res.json({ ok: true });
});

// === API: 削除 ===
app.delete('/api/delete/:id', (req, res) => {
    const id = parseInt(req.params.id);
    db.scripts = db.scripts.filter(s => s.id !== id);
    saveDB();
    console.log(`[delete] id=${id}`);
    res.json({ ok: true });
});

// === API: 個別表示 ===
app.get('/api/script/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const s = db.scripts.find(x => x.id === id);
    if (!s) return res.status(404).json({ error: "not found" });
    res.json({ name: s.name, content: s.content });
});

// === Frida Gadget が取得する agent.js ===
app.get('/agent.js', (req, res) => {
    res.type('application/javascript');
    const active = db.scripts.find(s => s.is_active);
    if (!active) {
        return res.send('console.log("[agent] no active script");');
    }
    console.log(`[agent.js] served "${active.name}" at ${new Date().toISOString()}`);
    res.send(active.content);
});

// === ヘルスチェック ===
app.get('/health', (req, res) => res.json({ ok: true, t: Date.now(), scripts: db.scripts.length }));

// === スリープ防止 ===
function startSelfPing() {
    if (!SELF_URL || SELF_URL.includes('localhost')) {
        console.log('[self-ping] skip (localhost)');
        return;
    }
    const pingUrl = `${SELF_URL}/health`;
    console.log(`[self-ping] start: ${pingUrl}`);
    setInterval(() => {
        https.get(pingUrl, (res) => {
            console.log(`[self-ping] ${res.statusCode} ${new Date().toISOString()}`);
            res.resume();
        }).on('error', (err) => {
            console.error(`[self-ping] error: ${err.message}`);
        });
    }, PING_INTERVAL_MS);
}

app.listen(port, () => {
    console.log(`[*] listening on port ${port}`);
    console.log(`[*] login: ${SELF_URL}/`);
    startSelfPing();
});
