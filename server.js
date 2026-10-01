// server.js - MilkChoco Agent Manager (JSON file storage + スリープ対策)
const express = require('express');
const path = require('path');
const https = require('https');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SELF_URL = process.env.SELF_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost'}`;
const PING_INTERVAL_MS = 7 * 60 * 1000;

// === データ保存先 ===
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'scripts.json');

// === インメモリDB ===
let db = {
    scripts: [],
    nextId: 1
};

// 起動時にファイルから読み込み
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

// === 認証 ===
function requireAuth(req, res, next) {
    const pwd = req.query.pwd || req.body.pwd;
    if (pwd === ADMIN_PASSWORD) return next();
    res.status(401).send(getLoginHTML('パスワードが違います'));
}

function getLoginHTML(error = '') {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Login</title>
<style>
body {font-family:sans-serif;background:#0d1117;color:#c9d1d9;padding:80px;text-align:center;}
.card {background:#161b22;padding:30px;border-radius:15px;display:inline-block;border:1px solid #30363d;}
input,button {padding:12px;margin:10px;width:280px;border:1px solid #30363d;border-radius:8px;background:#0d1117;color:#c9d1d9;}
button {background:#f85149;color:white;font-weight:bold;cursor:pointer;border:none;}
button:hover {background:#da3633;}
.error {color:#f85149;font-weight:bold;}
h2 {color:#f85149;}
</style></head>
<body><div class="card">
<h2>MilkChoco Agent Manager</h2>
<form method="POST" action="/login">
<input type="password" name="pwd" placeholder="パスワード" required autofocus><br>
<button type="submit">ログイン</button>
</form>
${error ? `<p class="error">${error}</p>` : ''}
</div></body></html>`;
}

app.get('/', (req, res) => res.send(getLoginHTML()));
app.post('/login', (req, res) => {
    if (req.body.pwd === ADMIN_PASSWORD) {
        res.redirect('/dashboard?pwd=' + encodeURIComponent(req.body.pwd));
    } else {
        res.send(getLoginHTML('パスワードが違います'));
    }
});

app.get('/dashboard', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === API: アップロード ===
app.post('/api/upload', requireAuth, (req, res) => {
    const { name, content } = req.body;
    if (!name || !content) return res.status(400).json({ error: "name and content required" });

    // 全てのアクティブを解除
    db.scripts.forEach(s => s.is_active = false);

    const script = {
        id: db.nextId++,
        name,
        content,
        size: Buffer.byteLength(content, 'utf8'),
        is_active: true,
        created: new Date().toISOString()
    };
    db.scripts.unshift(script);  // 新しいのを先頭に
    saveDB();

    console.log(`[upload] id=${script.id} name=${name} size=${script.size}`);
    res.json({ ok: true, id: script.id });
});

// === API: 一覧 ===
app.get('/api/list', requireAuth, (req, res) => {
    res.json({ scripts: db.scripts.map(s => ({
        id: s.id, name: s.name, size: s.size,
        is_active: s.is_active, created: s.created
    }))});
});

// === API: アクティブ切替 ===
app.post('/api/activate/:id', requireAuth, (req, res) => {
    const id = parseInt(req.params.id);
    db.scripts.forEach(s => s.is_active = (s.id === id));
    saveDB();
    console.log(`[activate] id=${id}`);
    res.json({ ok: true });
});

// === API: 削除 ===
app.delete('/api/delete/:id', requireAuth, (req, res) => {
    const id = parseInt(req.params.id);
    db.scripts = db.scripts.filter(s => s.id !== id);
    saveDB();
    console.log(`[delete] id=${id}`);
    res.json({ ok: true });
});

// === API: 個別表示 ===
app.get('/api/script/:id', requireAuth, (req, res) => {
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
