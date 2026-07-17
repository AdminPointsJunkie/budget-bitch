import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const extractor = fileURLToPath(new URL("./scripts/extract_pdf.py", import.meta.url));
const dataDirectory = fileURLToPath(new URL("./.data", import.meta.url));
mkdirSync(dataDirectory, { recursive:true });
const database = new DatabaseSync(`${dataDirectory}/ledgerly.db`);
database.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_date TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
if (!database.prepare("PRAGMA table_info(transactions)").all().some(column=>column.name==="is_subscription")) {
  database.exec("ALTER TABLE transactions ADD COLUMN is_subscription INTEGER NOT NULL DEFAULT 0");
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) reject(new Error("Request is too large"));
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, value, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(value));
}

function localDataServices() {
  return {
    name: "local-data-services",
    configureServer(server) {
      server.middlewares.use("/api/parse-pdf", async (req, res, next) => {
        if (req.method !== "POST") return next();
        try {
          const body = await readBody(req);
          const child = spawn("python3", [extractor], { stdio:["pipe","pipe","pipe"] });
          const output = [], errors = [];
          child.stdout.on("data", chunk => output.push(chunk));
          child.stderr.on("data", chunk => errors.push(chunk));
          child.on("close", code => {
            res.setHeader("Content-Type", "application/json");
            if (code !== 0) {
              sendJson(res, {error:Buffer.concat(errors).toString().trim() || "Unable to read PDF"}, 422);
            } else res.end(Buffer.concat(output));
          });
          child.stdin.end(body);
        } catch (error) {
          sendJson(res, {error:error.message}, 400);
        }
      });
      server.middlewares.use("/api/transactions", async (req, res, next) => {
        try {
          if (req.method === "GET" && req.url === "/") {
            const rows = database.prepare("SELECT id, tx_date AS date, description, category, amount, source, is_subscription AS isSubscription FROM transactions ORDER BY tx_date, id").all();
            return sendJson(res, {transactions:rows});
          }
          if (req.method === "POST" && req.url === "/") {
            const { transactions = [] } = JSON.parse((await readBody(req)).toString());
            const insert = database.prepare("INSERT OR IGNORE INTO transactions (tx_date, description, category, amount, source, fingerprint, is_subscription) VALUES (?, ?, ?, ?, ?, ?, ?)");
            database.exec("BEGIN");
            try {
              for (const transaction of transactions) {
                const source = transaction.source || "";
                const fingerprint = `${transaction.date}|${transaction.description}|${Number(transaction.amount).toFixed(2)}|${source}`;
                insert.run(transaction.date, transaction.description, transaction.category, transaction.amount, source, fingerprint, transaction.isSubscription?1:0);
              }
              database.exec("COMMIT");
            } catch (error) {
              database.exec("ROLLBACK");
              throw error;
            }
            const rows = database.prepare("SELECT id, tx_date AS date, description, category, amount, source, is_subscription AS isSubscription FROM transactions ORDER BY tx_date, id").all();
            return sendJson(res, {transactions:rows}, 201);
          }
          const match = req.url.match(/^\/(\d+)$/);
          if (req.method === "PATCH" && match) {
            const changes = JSON.parse((await readBody(req, 1024 * 20)).toString());
            if (changes.category !== undefined) database.prepare("UPDATE transactions SET category = ? WHERE id = ?").run(changes.category, Number(match[1]));
            if (changes.isSubscription !== undefined) database.prepare("UPDATE transactions SET is_subscription = ? WHERE id = ?").run(changes.isSubscription?1:0, Number(match[1]));
            return sendJson(res, {ok:true});
          }
          next();
        } catch (error) {
          sendJson(res, {error:error.message}, 400);
        }
      });
    }
  };
}

export default defineConfig({
  plugins:[react(), localDataServices()]
});
