// server.js - MilkChoco Agent Manager (SQLite + スリープ対策)
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const https = require('https');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// === 設定 ===
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SELF_URL = process.env.SELF_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost'}`;
const PING_INTERVAL_MS = 7 * 60 * 1000;  // 7分

// === ミドルウェア ===
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.text({ limit: '5mb', type: 'text/plain' }));

// === DB ===
// Render のディスクは再起動で消えるので /var/data を推奨
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const dbPath = path.join(DATA_DIR, 'agent.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("DB接続失敗:", err);
    else console.log(`DB接続: ${dbPath}`);
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS scripts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            content TEXT NOT NULL,
            size INTEGER NOT NULL,
            is_active INTEGER DEFAULT 0,
            created DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

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

// === ダッシュボード ===
app.get('/dashboard', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === API: アップロード ===
app.post('/api/upload', requireAuth, (req, res) => {
    const { name, content } = req.body;
    if (!name || !content) return res.status(400).json({ error: "name and content required" });
    const size = Buffer.byteLength(content, 'utf8');

    // 既存のアクティブを解除して、新規をアクティブに
    db.serialize(() => {
        db.run("UPDATE scripts SET is_active = 0");
        db.run(
            "INSERT INTO scripts (name, content, size, is_active) VALUES (?, ?, ?, 1)",
            [name, content, size],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                console.log(`[upload] id=${this.lastID} name=${name} size=${size}`);
                res.json({ ok: true, id: this.lastID });
            }
        );
    });
});

// === API: 一覧 ===
app.get('/api/list', requireAuth, (req, res) => {
    db.all(
        "SELECT id, name, size, is_active, created FROM scripts ORDER BY created DESC",
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ scripts: rows || [] });
        }
    );
});

// === API: アクティブ切替 ===
app.post('/api/activate/:id', requireAuth, (req, res) => {
    const id = parseInt(req.params.id);
    db.serialize(() => {
        db.run("UPDATE scripts SET is_active = 0");
        db.run("UPDATE scripts SET is_active = 1 WHERE id = ?", [id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            console.log(`[activate] id=${id}`);
            res.json({ ok: true });
        });
    });
});

// === API: 削除 ===
app.delete('/api/delete/:id', requireAuth, (req, res) => {
    const id = parseInt(req.params.id);
    db.run("DELETE FROM scripts WHERE id = ?", [id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        console.log(`[delete] id=${id}`);
        res.json({ ok: true });
    });
});

// === API: 個別表示 ===
app.get('/api/script/:id', requireAuth, (req, res) => {
    const id = parseInt(req.params.id);
    db.get("SELECT name, content FROM scripts WHERE id = ?", [id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "not found" });
        res.json(row);
    });
});

// === Frida Gadget が取得する agent.js（認証なし） ===
app.get('/agent.js', (req, res) => {
    db.get("SELECT content FROM scripts WHERE is_active = 1 LIMIT 1", (err, row) => {
        res.type('application/javascript');
        if (err || !row) {
            return res.send('console.log("[agent] no active script");');
        }
        console.log(`[agent.js] served at ${new Date().toISOString()}`);
        res.send(row.content);
    });
});

// === ヘルスチェック ===
app.get('/health', (req, res) => res.json({ ok: true, t: Date.now() }));

// === スリープ防止（自己ping） ===
function startSelfPing() {
    if (!SELF_URL || SELF_URL.includes('localhost')) {
        console.log('[self-ping] localhost のためスキップ');
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
