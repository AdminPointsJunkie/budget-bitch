import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const extractor = fileURLToPath(new URL("./scripts/extract_pdf.py", import.meta.url));
const dataDirectory = process.env.BUDGET_BITCH_DATA_DIR || fileURLToPath(new URL("./.data", import.meta.url));
mkdirSync(dataDirectory, { recursive:true });
const databasePath = `${dataDirectory}/ledgerly.db`;
const database = new DatabaseSync(databasePath);
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
if (!database.prepare("PRAGMA table_info(transactions)").all().some(column=>column.name==="subcategory")) {
  database.exec("ALTER TABLE transactions ADD COLUMN subcategory TEXT NOT NULL DEFAULT ''");
}
if (!database.prepare("PRAGMA table_info(transactions)").all().some(column=>column.name==="is_excluded")) {
  database.exec("ALTER TABLE transactions ADD COLUMN is_excluded INTEGER NOT NULL DEFAULT 0");
}
const transactionFingerprint = (date,description,amount) =>
  `${date}|${String(description).trim().replace(/\s+/g," ").toUpperCase()}|${Number(amount).toFixed(2)}`;
const storedTransactions = database.prepare("SELECT id, tx_date AS date, description, category, subcategory, amount, is_subscription AS isSubscription, is_excluded AS isExcluded FROM transactions ORDER BY id").all();
const transactionGroups = new Map();
for (const transaction of storedTransactions) {
  const fingerprint=transactionFingerprint(transaction.date,transaction.description,transaction.amount);
  if (!transactionGroups.has(fingerprint)) transactionGroups.set(fingerprint,[]);
  transactionGroups.get(fingerprint).push(transaction);
}
const duplicateGroups=[...transactionGroups.entries()].filter(([,rows])=>rows.length>1);
if (duplicateGroups.length) {
  const backupPath=`${dataDirectory}/ledgerly-pre-dedupe.db`;
  if (!existsSync(backupPath)) copyFileSync(databasePath,backupPath);
  const remove=database.prepare("DELETE FROM transactions WHERE id = ?");
  const setFingerprint=database.prepare("UPDATE transactions SET fingerprint = ? WHERE id = ?");
  const editScore=transaction=>(transaction.subcategory?8:0)+(transaction.category!=="Other"?4:0)+(transaction.isExcluded?2:0)+(transaction.isSubscription?1:0);
  database.exec("BEGIN");
  try {
    for (const [fingerprint,rows] of transactionGroups) {
      const ordered=rows.slice().sort((a,b)=>editScore(b)-editScore(a)||a.id-b.id);
      for (const duplicate of ordered.slice(1)) remove.run(duplicate.id);
      setFingerprint.run(fingerprint,ordered[0].id);
    }
    database.exec("COMMIT");
  } catch(error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
database.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    UNIQUE(name, parent_id)
  )
`);
database.exec("CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
const duplicateParents = database.prepare("SELECT name, MIN(id) AS keep_id FROM categories WHERE parent_id IS NULL GROUP BY name HAVING COUNT(*) > 1").all();
for (const duplicate of duplicateParents) {
  const duplicateIds = database.prepare("SELECT id FROM categories WHERE parent_id IS NULL AND name = ? AND id != ?").all(duplicate.name, duplicate.keep_id);
  for (const {id} of duplicateIds) {
    const children = database.prepare("SELECT name FROM categories WHERE parent_id = ?").all(id);
    for (const child of children) database.prepare("INSERT OR IGNORE INTO categories (name, parent_id) VALUES (?, ?)").run(child.name, duplicate.keep_id);
    database.prepare("DELETE FROM categories WHERE parent_id = ?").run(id);
    database.prepare("DELETE FROM categories WHERE id = ?").run(id);
  }
}
database.exec("DELETE FROM categories WHERE id NOT IN (SELECT MIN(id) FROM categories GROUP BY name, COALESCE(parent_id, 0))");
database.exec("CREATE UNIQUE INDEX IF NOT EXISTS categories_unique_name_parent ON categories(name, COALESCE(parent_id, 0))");
const defaultCategories = ["Housing","Groceries","Dining","Transport","Utilities","Shopping","Entertainment","Health","Insurance","Transfers","Income","Other"];
const seedCategory = database.prepare("INSERT OR IGNORE INTO categories (name, parent_id) VALUES (?, NULL)");
if (!database.prepare("SELECT COUNT(*) AS count FROM categories").get().count) defaultCategories.forEach(name=>seedCategory.run(name));
if (!database.prepare("SELECT value FROM app_meta WHERE key = 'interest_categories_v1'").get()) {
  database.prepare("INSERT OR IGNORE INTO categories (name, parent_id) VALUES ('Interest', NULL)").run();
  const interestId=database.prepare("SELECT id FROM categories WHERE name = 'Interest' AND parent_id IS NULL").get().id;
  database.prepare("INSERT OR IGNORE INTO categories (name, parent_id) VALUES ('Mortgage interest', ?)").run(interestId);
  database.prepare("INSERT OR IGNORE INTO categories (name, parent_id) VALUES ('Credit card interest', ?)").run(interestId);
  database.prepare(`UPDATE transactions SET category = 'Interest', subcategory = CASE
    WHEN LOWER(source) LIKE '%mortgage%' OR ABS(amount) >= 1000 THEN 'Mortgage interest'
    ELSE 'Credit card interest'
  END WHERE UPPER(TRIM(description)) = 'INTEREST CHARGE'`).run();
  database.prepare("INSERT INTO app_meta (key, value) VALUES ('interest_categories_v1', 'complete')").run();
}

function interestClassification(description,amount,source) {
  if (String(description).trim().toUpperCase()!=="INTEREST CHARGE") return null;
  const mortgage=/mortgage/i.test(String(source)) || Math.abs(Number(amount))>=1000;
  return {category:"Interest",subcategory:mortgage?"Mortgage interest":"Credit card interest"};
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
            const rows = database.prepare("SELECT id, tx_date AS date, description, category, subcategory, amount, source, is_subscription AS isSubscription, is_excluded AS isExcluded FROM transactions ORDER BY tx_date, id").all();
            return sendJson(res, {transactions:rows});
          }
          if (req.method === "POST" && req.url === "/") {
            const { transactions = [] } = JSON.parse((await readBody(req)).toString());
            const insert = database.prepare("INSERT OR IGNORE INTO transactions (tx_date, description, category, subcategory, amount, source, fingerprint, is_subscription, is_excluded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
            database.exec("BEGIN");
            try {
              for (const transaction of transactions) {
                const source = transaction.source || "";
                const fingerprint = transactionFingerprint(transaction.date,transaction.description,transaction.amount);
                const interest=interestClassification(transaction.description,transaction.amount,source);
                insert.run(transaction.date, transaction.description, interest?.category||transaction.category, interest?.subcategory||transaction.subcategory||"", transaction.amount, source, fingerprint, transaction.isSubscription?1:0, transaction.isExcluded?1:0);
              }
              database.exec("COMMIT");
            } catch (error) {
              database.exec("ROLLBACK");
              throw error;
            }
            const rows = database.prepare("SELECT id, tx_date AS date, description, category, subcategory, amount, source, is_subscription AS isSubscription, is_excluded AS isExcluded FROM transactions ORDER BY tx_date, id").all();
            return sendJson(res, {transactions:rows}, 201);
          }
          if (req.method === "PATCH" && req.url === "/bulk") {
            const {ids=[],category,subcategory=""} = JSON.parse((await readBody(req, 1024 * 1024)).toString());
            const validIds=[...new Set(ids.map(Number).filter(Number.isInteger))];
            if (!validIds.length || !String(category||"").trim()) return sendJson(res,{error:"Transaction IDs and category are required"},400);
            const update=database.prepare("UPDATE transactions SET category = ?, subcategory = ? WHERE id = ?");
            database.exec("BEGIN");
            try {
              for (const id of validIds) update.run(String(category).trim(),String(subcategory||"").trim(),id);
              database.exec("COMMIT");
            } catch(error) {
              database.exec("ROLLBACK");
              throw error;
            }
            return sendJson(res,{ok:true,updated:validIds.length});
          }
          if (req.method === "DELETE" && req.url === "/bulk") {
            const {ids=[]}=JSON.parse((await readBody(req,1024*1024)).toString());
            const validIds=[...new Set(ids.map(Number).filter(Number.isInteger))];
            const remove=database.prepare("DELETE FROM transactions WHERE id = ?");
            database.exec("BEGIN");
            try {
              for (const id of validIds) remove.run(id);
              database.exec("COMMIT");
            } catch(error) {
              database.exec("ROLLBACK");
              throw error;
            }
            return sendJson(res,{ok:true,deleted:validIds.length});
          }
          const match = req.url.match(/^\/(\d+)$/);
          if (req.method === "PATCH" && match) {
            const changes = JSON.parse((await readBody(req, 1024 * 20)).toString());
            if (changes.category !== undefined) database.prepare("UPDATE transactions SET category = ? WHERE id = ?").run(changes.category, Number(match[1]));
            if (changes.subcategory !== undefined) database.prepare("UPDATE transactions SET subcategory = ? WHERE id = ?").run(changes.subcategory, Number(match[1]));
            if (changes.isSubscription !== undefined) database.prepare("UPDATE transactions SET is_subscription = ? WHERE id = ?").run(changes.isSubscription?1:0, Number(match[1]));
            if (changes.isExcluded !== undefined) database.prepare("UPDATE transactions SET is_excluded = ? WHERE id = ?").run(changes.isExcluded?1:0, Number(match[1]));
            return sendJson(res, {ok:true});
          }
          if (req.method === "DELETE" && match) {
            database.prepare("DELETE FROM transactions WHERE id = ?").run(Number(match[1]));
            return sendJson(res,{ok:true});
          }
          next();
        } catch (error) {
          sendJson(res, {error:error.message}, 400);
        }
      });
      server.middlewares.use("/api/categories", async (req, res, next) => {
        try {
          if (req.method === "GET" && req.url === "/") {
            const rows=database.prepare("SELECT id, name, parent_id AS parentId FROM categories ORDER BY parent_id IS NOT NULL, name").all();
            return sendJson(res,{categories:rows});
          }
          if (req.method === "POST" && req.url === "/") {
            const {name,parentId=null}=JSON.parse((await readBody(req,1024*20)).toString());
            if (!String(name||"").trim()) return sendJson(res,{error:"Name is required"},400);
            database.prepare("INSERT OR IGNORE INTO categories (name,parent_id) VALUES (?,?)").run(String(name).trim(),parentId||null);
            const rows=database.prepare("SELECT id, name, parent_id AS parentId FROM categories ORDER BY parent_id IS NOT NULL, name").all();
            return sendJson(res,{categories:rows},201);
          }
          const match=req.url.match(/^\/(\d+)$/);
          if (req.method === "DELETE" && match) {
            const category=database.prepare("SELECT id, name, parent_id AS parentId FROM categories WHERE id = ?").get(Number(match[1]));
            if (!category) return sendJson(res,{error:"Category not found"},404);
            if (!category.parentId && category.name==="Other") return sendJson(res,{error:"Other is the fallback category and cannot be deleted"},400);
            if (category.parentId) {
              const parent=database.prepare("SELECT name FROM categories WHERE id = ?").get(category.parentId);
              if (parent) database.prepare("UPDATE transactions SET subcategory = '' WHERE category = ? AND subcategory = ?").run(parent.name,category.name);
            } else {
              database.prepare("UPDATE transactions SET category = 'Other', subcategory = '' WHERE category = ?").run(category.name);
            }
            database.prepare("DELETE FROM categories WHERE id = ?").run(category.id);
            const rows=database.prepare("SELECT id, name, parent_id AS parentId FROM categories ORDER BY parent_id IS NOT NULL, name").all();
            return sendJson(res,{categories:rows});
          }
          next();
        } catch(error) {
          sendJson(res,{error:error.message},400);
        }
      });
    }
  };
}

export default defineConfig({
  cacheDir:`${dataDirectory}/vite-cache`,
  plugins:[react(), localDataServices()]
});
