const express = require("express");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL 接続
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("render.com")
        ? { rejectUnauthorized: false }
        : false
});

// テーブル自動初期化
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS scripts (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            is_active BOOLEAN DEFAULT FALSE
        );
    `);
    console.log("[db] initialized");
}
initDB().catch(e => console.error("[db] init failed:", e));

// JSONボディ（1MBまで）
app.use(express.json({ limit: "1mb" }));
app.use(express.text({ limit: "1mb", type: "text/plain" }));

// 静的ファイル（管理UI）
app.use(express.static(path.join(__dirname, "public")));

// =============================================================
//  アップロード
// =============================================================
app.post("/api/upload", async (req, res) => {
    try {
        const { name, content } = req.body;
        if (!name || !content) return res.status(400).json({ error: "name and content required" });

        // 既存のアクティブを解除（新規アップは自動でアクティブに）
        await pool.query("UPDATE scripts SET is_active = FALSE WHERE is_active = TRUE");

        const result = await pool.query(
            "INSERT INTO scripts (name, content, is_active) VALUES ($1, $2, TRUE) RETURNING id, name, created_at",
            [name, content]
        );
        res.json({ ok: true, script: result.rows[0] });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================
//  一覧取得
// =============================================================
app.get("/api/list", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, name, created_at, is_active, LENGTH(content) AS size FROM scripts ORDER BY created_at DESC"
        );
        res.json({ scripts: result.rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// =============================================================
//  アクティブ切り替え
// =============================================================
app.post("/api/activate/:id", async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await pool.query("UPDATE scripts SET is_active = FALSE");
        await pool.query("UPDATE scripts SET is_active = TRUE WHERE id = $1", [id]);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// =============================================================
//  削除
// =============================================================
app.delete("/api/delete/:id", async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await pool.query("DELETE FROM scripts WHERE id = $1", [id]);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// =============================================================
//  Frida Gadget が取得する agent.js
// =============================================================
app.get("/agent.js", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT content FROM scripts WHERE is_active = TRUE LIMIT 1"
        );
        if (result.rows.length === 0) {
            return res.type("application/javascript").send(
                'console.log("[agent] no active script");'
            );
        }
        res.type("application/javascript").send(result.rows[0].content);
        console.log(`[agent.js] served at ${new Date().toISOString()}`);
    } catch (e) {
        res.type("application/javascript").send(
            `console.log("[agent] error: ${e.message}");`
        );
    }
});

// =============================================================
//  個別バージョンの内容表示（プレビュー用）
// =============================================================
app.get("/api/script/:id", async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const result = await pool.query("SELECT name, content FROM scripts WHERE id = $1", [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: "not found" });
        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`[*] server listening on port ${PORT}`);
});
