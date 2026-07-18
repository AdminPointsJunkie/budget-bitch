import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const extractor = fileURLToPath(new URL("./scripts/extract_pdf.py", import.meta.url));
const dataDirectory = process.env.BUDGET_BITCH_DATA_DIR || fileURLToPath(new URL("./.data", import.meta.url));
mkdirSync(dataDirectory, { recursive:true });
const databasePath = `${dataDirectory}/ledgerly.db`;
const statementsDirectory = join(dataDirectory,"statements");
mkdirSync(statementsDirectory,{recursive:true});
const receiptsDirectory=join(dataDirectory,"receipts");
const documentsDirectory=join(dataDirectory,"documents");
mkdirSync(receiptsDirectory,{recursive:true});
mkdirSync(documentsDirectory,{recursive:true});
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
function canonicalImportDescription(description,amount) {
  let value=String(description||"").trim().replace(/\s+/g," ");
  const trailing=value.match(/(-?\$?[\d,]+\.\d{2})$/);
  if (trailing) {
    const trailingAmount=Math.abs(Number(trailing[1].replace(/[$,]/g,"")));
    if (Number.isFinite(trailingAmount)&&Math.abs(trailingAmount-Math.abs(Number(amount)))<0.005) value=value.slice(0,trailing.index).trim();
  }
  return value.toUpperCase();
}
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
database.exec("CREATE TABLE IF NOT EXISTS statements (filename TEXT PRIMARY KEY, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
database.exec(`CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL DEFAULT 'Imported transactions',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
database.exec(`CREATE TABLE IF NOT EXISTS import_batch_transactions (
  batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  PRIMARY KEY (batch_id, transaction_id)
)`);
database.exec(`CREATE TABLE IF NOT EXISTS transaction_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
database.exec(`CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  stored_name TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  title TEXT NOT NULL DEFAULT '',
  document_date TEXT NOT NULL,
  employer TEXT NOT NULL DEFAULT '',
  gross REAL NOT NULL DEFAULT 0,
  net REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
const rememberStatement=database.prepare("INSERT OR IGNORE INTO statements (filename) VALUES (?)");
const pdfSources=database.prepare("SELECT DISTINCT source FROM transactions WHERE LOWER(source) LIKE '%.pdf'").all();
const knownStatementFiles=new Set(pdfSources.map(({source})=>basename(source)));
for (const filename of knownStatementFiles) {
  const storedPath=join(statementsDirectory,filename);
  const downloadPath=join(homedir(),"Downloads",filename);
  if (!existsSync(storedPath)&&existsSync(downloadPath)) copyFileSync(downloadPath,storedPath);
  if (existsSync(storedPath)) rememberStatement.run(filename);
}
if (!database.prepare("SELECT COUNT(*) AS count FROM import_batches").get().count) {
  const latestStatement=database.prepare("SELECT filename FROM statements ORDER BY imported_at DESC LIMIT 1").get();
  if (latestStatement) {
    const transactionIds=database.prepare("SELECT id FROM transactions WHERE source = ? ORDER BY id").all(latestStatement.filename);
    if (transactionIds.length) {
      const batch=database.prepare("INSERT INTO import_batches (label) VALUES (?)").run(latestStatement.filename);
      const link=database.prepare("INSERT OR IGNORE INTO import_batch_transactions (batch_id, transaction_id) VALUES (?, ?)");
      transactionIds.forEach(({id})=>link.run(batch.lastInsertRowid,id));
    }
  }
}
database.exec(`CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  bank TEXT NOT NULL,
  name TEXT NOT NULL,
  account_number TEXT NOT NULL DEFAULT '',
  bsb TEXT NOT NULL DEFAULT '',
  source_pattern TEXT NOT NULL,
  cadence_months INTEGER NOT NULL DEFAULT 1
)`);
const seedAccount=database.prepare("INSERT OR IGNORE INTO accounts (id, bank, name, account_number, bsb, source_pattern, cadence_months) VALUES (?, ?, ?, ?, ?, ?, ?)");
seedAccount.run("amex-explorer","American Express","Explorer Credit Card","Ending 93007","","^08_",1);
seedAccount.run("hsbc-everyday","HSBC","Everyday Global","136991090","342-201","_Statement.pdf$",1);
seedAccount.run("ing-orange","ING","Orange Everyday","311458516","923-100","^Orange_Everyday_",3);
seedAccount.run("ing-mortgage","ING","Mortgage Simplifier","29775089","923-100","^Mortgage_Simplifier_",6);
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
const defaultCategories = ["Uncategorised","Housing","Groceries","Dining","Transport","Utilities","Shopping","Entertainment","Health","Insurance","Transfers","Income","Other"];
const seedCategory = database.prepare("INSERT OR IGNORE INTO categories (name, parent_id) VALUES (?, NULL)");
if (!database.prepare("SELECT COUNT(*) AS count FROM categories").get().count) defaultCategories.forEach(name=>seedCategory.run(name));
seedCategory.run("Uncategorised");
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
if (!database.prepare("SELECT value FROM app_meta WHERE key = 'tesla_payments_v1'").get()) {
  const teslaPayments=database.prepare("SELECT id, tx_date AS date, description, amount FROM transactions WHERE amount > 0 AND LOWER(description) LIKE '%tesla payment%'").all();
  const updateTeslaPayment=database.prepare("UPDATE transactions SET amount = ?, fingerprint = ? WHERE id = ?");
  database.exec("BEGIN");
  try {
    for (const transaction of teslaPayments) {
      const amount=-Math.abs(transaction.amount);
      updateTeslaPayment.run(amount,transactionFingerprint(transaction.date,transaction.description,amount),transaction.id);
    }
    database.prepare("INSERT INTO app_meta (key, value) VALUES ('tesla_payments_v1', 'complete')").run();
    database.exec("COMMIT");
  } catch(error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
if (!database.prepare("SELECT value FROM app_meta WHERE key = 'amex_year_rollover_v1'").get()) {
  const rolloverTransactions=database.prepare("SELECT id, tx_date AS date, description, amount FROM transactions WHERE source = '08_Dec_2025_-_07_Jan_2026.pdf' AND tx_date LIKE '2026-12-%'").all();
  const updateRollover=database.prepare("UPDATE transactions SET tx_date = ?, fingerprint = ? WHERE id = ?");
  database.exec("BEGIN");
  try {
    for (const transaction of rolloverTransactions) {
      const date=transaction.date.replace(/^2026-/,"2025-");
      updateRollover.run(date,transactionFingerprint(date,transaction.description,transaction.amount),transaction.id);
    }
    database.prepare("INSERT INTO app_meta (key, value) VALUES ('amex_year_rollover_v1', 'complete')").run();
    database.exec("COMMIT");
  } catch(error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const ledgerRegistryPath=join(dataDirectory,"ledgers.json");
let ledgers=existsSync(ledgerRegistryPath)
  ? JSON.parse(readFileSync(ledgerRegistryPath,"utf8"))
  : [{id:"johns-ledger",name:"John’s Ledger",createdAt:new Date().toISOString(),root:true}];
if (!ledgers.some(ledger=>ledger.id==="johns-ledger")) ledgers.unshift({id:"johns-ledger",name:"John’s Ledger",createdAt:new Date().toISOString(),root:true});
const saveLedgers=()=>writeFileSync(ledgerRegistryPath,JSON.stringify(ledgers,null,2));
saveLedgers();
const ledgerDatabases=new Map([["johns-ledger",database]]);
function ledgerRecord(id) {
  return ledgers.find(ledger=>ledger.id===id)||ledgers[0];
}
function ledgerPaths(id) {
  const ledger=ledgerRecord(id);
  const root=ledger.root?dataDirectory:join(dataDirectory,"ledgers",ledger.id);
  const paths={root,statementsDirectory:join(root,"statements"),receiptsDirectory:join(root,"receipts"),documentsDirectory:join(root,"documents")};
  Object.values(paths).forEach(path=>mkdirSync(path,{recursive:true}));
  return paths;
}
function initializeBlankLedger(id) {
  const paths=ledgerPaths(id);
  const ledgerDatabase=new DatabaseSync(join(paths.root,"ledgerly.db"));
  ledgerDatabase.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_date TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL UNIQUE,
      is_subscription INTEGER NOT NULL DEFAULT 0,
      is_excluded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
      UNIQUE(name, parent_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS categories_unique_name_parent ON categories(name, COALESCE(parent_id, 0));
    CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS statements (filename TEXT PRIMARY KEY, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL DEFAULT 'Imported transactions',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS import_batch_transactions (
      batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      PRIMARY KEY (batch_id, transaction_id)
    );
    CREATE TABLE IF NOT EXISTS transaction_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      stored_name TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      filename TEXT NOT NULL DEFAULT '',
      stored_name TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      title TEXT NOT NULL DEFAULT '',
      document_date TEXT NOT NULL,
      employer TEXT NOT NULL DEFAULT '',
      gross REAL NOT NULL DEFAULT 0,
      net REAL NOT NULL DEFAULT 0,
      tax REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      category TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      bank TEXT NOT NULL,
      name TEXT NOT NULL,
      account_number TEXT NOT NULL DEFAULT '',
      bsb TEXT NOT NULL DEFAULT '',
      source_pattern TEXT NOT NULL,
      cadence_months INTEGER NOT NULL DEFAULT 1
    );
  `);
  const insertCategory=ledgerDatabase.prepare("INSERT OR IGNORE INTO categories (name, parent_id) VALUES (?, NULL)");
  [...defaultCategories,"Interest"].forEach(name=>insertCategory.run(name));
  const interestId=ledgerDatabase.prepare("SELECT id FROM categories WHERE name = 'Interest' AND parent_id IS NULL").get().id;
  ledgerDatabase.prepare("INSERT OR IGNORE INTO categories (name, parent_id) VALUES ('Mortgage interest', ?)").run(interestId);
  ledgerDatabase.prepare("INSERT OR IGNORE INTO categories (name, parent_id) VALUES ('Credit card interest', ?)").run(interestId);
  ledgerDatabases.set(id,ledgerDatabase);
  return ledgerDatabase;
}
function ensureImportTables(ledgerDatabase) {
  ledgerDatabase.exec(`
    CREATE TABLE IF NOT EXISTS import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL DEFAULT 'Imported transactions',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS import_batch_transactions (
      batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      PRIMARY KEY (batch_id, transaction_id)
    );
  `);
  ledgerDatabase.prepare("INSERT OR IGNORE INTO categories (name, parent_id) VALUES ('Uncategorised', NULL)").run();
}
function databaseForLedger(id) {
  const ledger=ledgerRecord(id);
  if (ledgerDatabases.has(ledger.id)) return ledgerDatabases.get(ledger.id);
  const path=join(ledgerPaths(ledger.id).root,"ledgerly.db");
  if (!existsSync(path)) return initializeBlankLedger(ledger.id);
  const ledgerDatabase=new DatabaseSync(path);
  ensureImportTables(ledgerDatabase);
  ledgerDatabases.set(ledger.id,ledgerDatabase);
  return ledgerDatabase;
}
function ledgerIdForRequest(req) {
  const queryLedger=new URL(req.url||"/","http://local").searchParams.get("ledgerId");
  const requested=String(req.headers["x-ledger-id"]||queryLedger||"johns-ledger");
  return ledgers.some(ledger=>ledger.id===requested)?requested:"johns-ledger";
}
function seedDetectedAccounts(ledgerDatabase,filenames) {
  const names=[...filenames];
  const insert=ledgerDatabase.prepare("INSERT OR IGNORE INTO accounts (id, bank, name, account_number, bsb, source_pattern, cadence_months) VALUES (?, ?, ?, ?, ?, ?, ?)");
  if (names.some(name=>/^08_/i.test(name))) insert.run("amex-explorer","American Express","Explorer Credit Card","Ending 93007","","^08_",1);
  if (names.some(name=>/_Statement\.pdf$/i.test(name))) insert.run("hsbc-everyday","HSBC","Everyday Global","136991090","342-201","_Statement.pdf$",1);
  if (names.some(name=>/^Orange_Everyday_/i.test(name))) insert.run("ing-orange","ING","Orange Everyday","311458516","923-100","^Orange_Everyday_",3);
  if (names.some(name=>/^Mortgage_Simplifier_/i.test(name))) insert.run("ing-mortgage","ING","Mortgage Simplifier","29775089","923-100","^Mortgage_Simplifier_",6);
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

const statementMonths={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
function statementCoverage(filename) {
  let match=filename.match(/^(\d{2})_([A-Za-z]{3})_(\d{4})_-_(\d{2})_([A-Za-z]{3})_(\d{4})/);
  if (match) return {
    start:new Date(Number(match[3]),statementMonths[match[2].toLowerCase()],Number(match[1]),12),
    end:new Date(Number(match[6]),statementMonths[match[5].toLowerCase()],Number(match[4]),12)
  };
  match=filename.match(/^(\d{2})-(\d{2})-(\d{4})_Statement/i);
  if (match) {
    const end=new Date(Number(match[3]),Number(match[2])-1,Number(match[1]),12);
    const start=new Date(end); start.setMonth(start.getMonth()-1);
    return {start,end};
  }
  match=filename.match(/_(\d{4})-(\d{2})-(\d{2})_(\d{4})-(\d{2})-(\d{2})\.pdf$/i);
  if (match) return {
    start:new Date(Number(match[1]),Number(match[2])-1,Number(match[3]),12),
    end:new Date(Number(match[4]),Number(match[5])-1,Number(match[6]),12)
  };
  return null;
}
function accountOverview(account,statementRows) {
  const pattern=new RegExp(account.source_pattern,"i");
  const statements=statementRows.filter(statement=>pattern.test(statement.filename)).map(statement=>({...statement,coverage:statementCoverage(statement.filename)})).filter(statement=>statement.coverage).sort((a,b)=>a.coverage.end-b.coverage.end);
  const missing=[];
  for (let index=1;index<statements.length;index+=1) {
    const previous=statements[index-1].coverage.end;
    const current=statements[index].coverage.end;
    const monthGap=(current.getFullYear()-previous.getFullYear())*12+current.getMonth()-previous.getMonth();
    if (monthGap>account.cadence_months+1) missing.push(`${previous.toLocaleDateString("en-AU",{month:"short",year:"numeric"})} – ${current.toLocaleDateString("en-AU",{month:"short",year:"numeric"})}`);
  }
  const latest=statements.at(-1);
  const staleAfterDays=Math.max(45,account.cadence_months*35);
  const daysSinceLatest=latest?Math.floor((Date.now()-latest.coverage.end.getTime())/86400000):null;
  return {...account,statementCount:statements.length,latestStatement:latest?.filename||"",latestStatementEnd:latest?.coverage.end.toISOString().slice(0,10)||"",daysSinceLatest,missingPeriods:missing,status:!latest?"missing":daysSinceLatest>staleAfterDays?"stale":missing.length?"gap":"current"};
}

function localDataServices() {
  return {
    name: "local-data-services",
    configureServer(server) {
      server.middlewares.use("/api/ledgers",async(req,res,next)=>{
        try {
          if (req.method==="GET"&&req.url==="/") {
            const summaries=ledgers.map(ledger=>{
              const ledgerDatabase=databaseForLedger(ledger.id);
              return {...ledger,transactionCount:ledgerDatabase.prepare("SELECT COUNT(*) AS count FROM transactions").get().count,statementCount:ledgerDatabase.prepare("SELECT COUNT(*) AS count FROM statements").get().count};
            });
            return sendJson(res,{ledgers:summaries});
          }
          if (req.method==="POST"&&req.url==="/") {
            const {name}=JSON.parse((await readBody(req,1024*20)).toString());
            const ledgerName=String(name||"").trim();
            if (!ledgerName) return sendJson(res,{error:"Ledger name is required"},400);
            const ledger={id:`ledger-${randomUUID()}`,name:ledgerName,createdAt:new Date().toISOString(),root:false};
            ledgers.push(ledger);
            saveLedgers();
            initializeBlankLedger(ledger.id);
            return sendJson(res,{ledger},201);
          }
          const match=req.url.match(/^\/([^/]+)$/);
          if (req.method==="PATCH"&&match) {
            const id=decodeURIComponent(match[1]);
            const ledger=ledgers.find(item=>item.id===id);
            if (!ledger) return sendJson(res,{error:"Ledger not found"},404);
            const {name}=JSON.parse((await readBody(req,1024*20)).toString());
            const ledgerName=String(name||"").trim();
            if (!ledgerName) return sendJson(res,{error:"Ledger name is required"},400);
            ledger.name=ledgerName;
            saveLedgers();
            return sendJson(res,{ledger,ledgers});
          }
          next();
        } catch(error) {
          sendJson(res,{error:error.message},400);
        }
      });
      server.middlewares.use("/api/parse-pdf", async (req, res, next) => {
        if (req.method !== "POST") return next();
        try {
          const ledgerId=ledgerIdForRequest(req);
          const database=databaseForLedger(ledgerId);
          const {statementsDirectory}=ledgerPaths(ledgerId);
          const body = await readBody(req);
          const child = spawn("python3", [extractor], { stdio:["pipe","pipe","pipe"] });
          const output = [], errors = [];
          child.stdout.on("data", chunk => output.push(chunk));
          child.stderr.on("data", chunk => errors.push(chunk));
          child.on("close", code => {
            res.setHeader("Content-Type", "application/json");
            if (code !== 0) {
              sendJson(res, {error:Buffer.concat(errors).toString().trim() || "Unable to read PDF"}, 422);
            } else {
              const filename=basename(decodeURIComponent(String(req.headers["x-statement-filename"]||"statement.pdf")));
              writeFileSync(join(statementsDirectory,filename),body);
              database.prepare("INSERT OR IGNORE INTO statements (filename) VALUES (?)").run(filename);
              seedDetectedAccounts(database,[filename]);
              res.end(Buffer.concat(output));
            }
          });
          child.stdin.end(body);
        } catch (error) {
          sendJson(res, {error:error.message}, 400);
        }
      });
      server.middlewares.use("/api/statements", async (req,res,next)=>{
        try {
          const ledgerId=ledgerIdForRequest(req);
          const database=databaseForLedger(ledgerId);
          const {statementsDirectory}=ledgerPaths(ledgerId);
          if (req.method==="GET"&&req.url==="/") {
            const statements=database.prepare(`SELECT statements.filename, statements.imported_at AS importedAt,
              (SELECT COUNT(*) FROM transactions WHERE transactions.source = statements.filename) AS transactionCount
              FROM statements ORDER BY statements.filename`).all();
            return sendJson(res,{statements});
          }
          const match=new URL(req.url,"http://local").pathname.match(/^\/file\/(.+)$/);
          if (req.method==="GET"&&match) {
            const filename=basename(decodeURIComponent(match[1]));
            const path=join(statementsDirectory,filename);
            if (!existsSync(path)) return sendJson(res,{error:"Statement file not found"},404);
            res.statusCode=200;
            res.setHeader("Content-Type","application/pdf");
            res.setHeader("Content-Disposition",`inline; filename="${filename.replaceAll('"',"")}"`);
            return res.end(readFileSync(path));
          }
          next();
        } catch(error) {
          sendJson(res,{error:error.message},400);
        }
      });
      server.middlewares.use("/api/accounts", async (req,res,next)=>{
        try {
          const database=databaseForLedger(ledgerIdForRequest(req));
          const statementRows=database.prepare("SELECT filename FROM statements ORDER BY filename").all();
          if (req.method==="GET"&&req.url==="/") {
            const accounts=database.prepare("SELECT id, bank, name, account_number AS accountNumber, bsb, source_pattern AS sourcePattern, cadence_months AS cadenceMonths FROM accounts ORDER BY bank, name").all();
            return sendJson(res,{accounts:accounts.map(account=>accountOverview({...account,source_pattern:account.sourcePattern,cadence_months:account.cadenceMonths},statementRows))});
          }
          const match=req.url.match(/^\/([^/]+)$/);
          if (req.method==="PATCH"&&match) {
            const id=decodeURIComponent(match[1]);
            const changes=JSON.parse((await readBody(req,1024*20)).toString());
            const account=database.prepare("SELECT id FROM accounts WHERE id = ?").get(id);
            if (!account) return sendJson(res,{error:"Account not found"},404);
            const bank=String(changes.bank||"").trim(),name=String(changes.name||"").trim();
            if (!bank||!name) return sendJson(res,{error:"Bank and account name are required"},400);
            database.prepare("UPDATE accounts SET bank = ?, name = ?, account_number = ?, bsb = ? WHERE id = ?").run(bank,name,String(changes.accountNumber||"").trim(),String(changes.bsb||"").trim(),id);
            const updated=database.prepare("SELECT id, bank, name, account_number AS accountNumber, bsb, source_pattern AS sourcePattern, cadence_months AS cadenceMonths FROM accounts ORDER BY bank, name").all();
            return sendJson(res,{accounts:updated.map(item=>accountOverview({...item,source_pattern:item.sourcePattern,cadence_months:item.cadenceMonths},statementRows))});
          }
          next();
        } catch(error) {
          sendJson(res,{error:error.message},400);
        }
      });
      server.middlewares.use("/api/receipts", async (req,res,next)=>{
        try {
          const ledgerId=ledgerIdForRequest(req);
          const database=databaseForLedger(ledgerId);
          const {receiptsDirectory}=ledgerPaths(ledgerId);
          if (req.method==="GET"&&req.url.startsWith("/?")) {
            const transactionId=Number(new URL(req.url,"http://local").searchParams.get("transactionId"));
            const receipts=database.prepare("SELECT id, transaction_id AS transactionId, filename, mime_type AS mimeType, created_at AS createdAt FROM transaction_attachments WHERE transaction_id = ? ORDER BY id DESC").all(transactionId);
            return sendJson(res,{receipts});
          }
          let match=new URL(req.url,"http://local").pathname.match(/^\/file\/(\d+)$/);
          if (req.method==="GET"&&match) {
            const receipt=database.prepare("SELECT filename, stored_name AS storedName, mime_type AS mimeType FROM transaction_attachments WHERE id = ?").get(Number(match[1]));
            if (!receipt||!existsSync(join(receiptsDirectory,receipt.storedName))) return sendJson(res,{error:"Receipt not found"},404);
            res.statusCode=200;
            res.setHeader("Content-Type",receipt.mimeType);
            res.setHeader("Content-Disposition",`inline; filename="${receipt.filename.replaceAll('"',"")}"`);
            return res.end(readFileSync(join(receiptsDirectory,receipt.storedName)));
          }
          match=req.url.match(/^\/(\d+)$/);
          if (req.method==="POST"&&match) {
            const transactionId=Number(match[1]);
            if (!database.prepare("SELECT id FROM transactions WHERE id = ?").get(transactionId)) return sendJson(res,{error:"Transaction not found"},404);
            const filename=basename(decodeURIComponent(String(req.headers["x-file-name"]||"receipt")));
            const mimeType=String(req.headers["content-type"]||"application/octet-stream");
            const body=await readBody(req);
            if (!body.length) return sendJson(res,{error:"Receipt file is empty"},400);
            const result=database.prepare("INSERT INTO transaction_attachments (transaction_id, filename, mime_type) VALUES (?, ?, ?)").run(transactionId,filename,mimeType);
            const storedName=`${result.lastInsertRowid}-${filename}`;
            writeFileSync(join(receiptsDirectory,storedName),body);
            database.prepare("UPDATE transaction_attachments SET stored_name = ? WHERE id = ?").run(storedName,result.lastInsertRowid);
            return sendJson(res,{ok:true,id:Number(result.lastInsertRowid)},201);
          }
          if (req.method==="DELETE"&&match) {
            const receipt=database.prepare("SELECT stored_name AS storedName FROM transaction_attachments WHERE id = ?").get(Number(match[1]));
            database.prepare("DELETE FROM transaction_attachments WHERE id = ?").run(Number(match[1]));
            if (receipt?.storedName&&existsSync(join(receiptsDirectory,receipt.storedName))) {
              const {unlinkSync}=await import("node:fs");
              unlinkSync(join(receiptsDirectory,receipt.storedName));
            }
            return sendJson(res,{ok:true});
          }
          next();
        } catch(error) {
          sendJson(res,{error:error.message},400);
        }
      });
      server.middlewares.use("/api/documents", async (req,res,next)=>{
        try {
          const ledgerId=ledgerIdForRequest(req);
          const database=databaseForLedger(ledgerId);
          const {documentsDirectory}=ledgerPaths(ledgerId);
          if (req.method==="GET"&&(req.url==="/"||req.url.startsWith("/?"))) {
            const type=new URL(req.url,"http://local").searchParams.get("type");
            const documents=type
              ? database.prepare("SELECT id, type, filename, mime_type AS mimeType, title, document_date AS documentDate, employer, gross, net, tax, amount, category, notes, created_at AS createdAt FROM documents WHERE type = ? ORDER BY document_date DESC, id DESC").all(type)
              : database.prepare("SELECT id, type, filename, mime_type AS mimeType, title, document_date AS documentDate, employer, gross, net, tax, amount, category, notes, created_at AS createdAt FROM documents ORDER BY document_date DESC, id DESC").all();
            return sendJson(res,{documents});
          }
          let match=new URL(req.url,"http://local").pathname.match(/^\/file\/(\d+)$/);
          if (req.method==="GET"&&match) {
            const document=database.prepare("SELECT filename, stored_name AS storedName, mime_type AS mimeType FROM documents WHERE id = ?").get(Number(match[1]));
            if (!document?.storedName||!existsSync(join(documentsDirectory,document.storedName))) return sendJson(res,{error:"Document file not found"},404);
            res.statusCode=200;
            res.setHeader("Content-Type",document.mimeType);
            res.setHeader("Content-Disposition",`inline; filename="${document.filename.replaceAll('"',"")}"`);
            return res.end(readFileSync(join(documentsDirectory,document.storedName)));
          }
          match=req.url.match(/^\/(payslip|deduction)$/);
          if (req.method==="POST"&&match) {
            const type=match[1];
            const meta=JSON.parse(decodeURIComponent(String(req.headers["x-document-meta"]||"%7B%7D")));
            const filename=basename(decodeURIComponent(String(req.headers["x-file-name"]||"")));
            const mimeType=String(req.headers["content-type"]||"application/octet-stream");
            const body=await readBody(req);
            if (!String(meta.documentDate||"").match(/^\d{4}-\d{2}-\d{2}$/)) return sendJson(res,{error:"A valid document date is required"},400);
            if (type==="payslip"&&!body.length) return sendJson(res,{error:"Choose a pay slip file"},400);
            const result=database.prepare(`INSERT INTO documents (type, filename, mime_type, title, document_date, employer, gross, net, tax, amount, category, notes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(type,filename,mimeType,String(meta.title||"").trim(),meta.documentDate,String(meta.employer||"").trim(),Number(meta.gross)||0,Number(meta.net)||0,Number(meta.tax)||0,Number(meta.amount)||0,String(meta.category||"").trim(),String(meta.notes||"").trim());
            if (body.length&&filename) {
              const storedName=`${result.lastInsertRowid}-${filename}`;
              writeFileSync(join(documentsDirectory,storedName),body);
              database.prepare("UPDATE documents SET stored_name = ? WHERE id = ?").run(storedName,result.lastInsertRowid);
            }
            return sendJson(res,{ok:true,id:Number(result.lastInsertRowid)},201);
          }
          match=req.url.match(/^\/(\d+)$/);
          if (req.method==="DELETE"&&match) {
            const document=database.prepare("SELECT stored_name AS storedName FROM documents WHERE id = ?").get(Number(match[1]));
            database.prepare("DELETE FROM documents WHERE id = ?").run(Number(match[1]));
            if (document?.storedName&&existsSync(join(documentsDirectory,document.storedName))) {
              const {unlinkSync}=await import("node:fs");
              unlinkSync(join(documentsDirectory,document.storedName));
            }
            return sendJson(res,{ok:true});
          }
          next();
        } catch(error) {
          sendJson(res,{error:error.message},400);
        }
      });
      server.middlewares.use("/api/system/photos",(req,res,next)=>{
        if (req.method!=="POST") return next();
        const child=spawn("open",["-a","Photos"],{stdio:"ignore"});
        child.unref();
        sendJson(res,{ok:true});
      });
      server.middlewares.use("/api/imports",(req,res,next)=>{
        try {
          const database=databaseForLedger(ledgerIdForRequest(req));
          if (req.method==="GET"&&req.url==="/latest") {
            const batch=database.prepare("SELECT id, label, created_at AS createdAt FROM import_batches ORDER BY id DESC LIMIT 1").get();
            if (!batch) return sendJson(res,{latestImport:null});
            const transactionIds=database.prepare("SELECT transaction_id AS id FROM import_batch_transactions WHERE batch_id = ? ORDER BY transaction_id").all(batch.id).map(row=>row.id);
            return sendJson(res,{latestImport:{...batch,transactionIds}});
          }
          next();
        } catch(error) {
          sendJson(res,{error:error.message},400);
        }
      });
      server.middlewares.use("/api/transactions", async (req, res, next) => {
        try {
          const database=databaseForLedger(ledgerIdForRequest(req));
          if (req.method === "GET" && req.url === "/") {
            const rows = database.prepare("SELECT id, tx_date AS date, description, category, subcategory, amount, source, is_subscription AS isSubscription, is_excluded AS isExcluded, (SELECT COUNT(*) FROM transaction_attachments WHERE transaction_id = transactions.id) AS receiptCount FROM transactions ORDER BY tx_date, id").all();
            return sendJson(res, {transactions:rows});
          }
          if (req.method === "POST" && req.url === "/") {
            const { transactions = [] } = JSON.parse((await readBody(req)).toString());
            seedDetectedAccounts(database,transactions.map(transaction=>transaction.source||""));
            const insert = database.prepare("INSERT OR IGNORE INTO transactions (tx_date, description, category, subcategory, amount, source, fingerprint, is_subscription, is_excluded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
            const existingByFingerprint=database.prepare("SELECT id, source FROM transactions WHERE fingerprint = ?");
            const existingByDateAmount=database.prepare("SELECT id, source, description FROM transactions WHERE tx_date = ? AND amount = ?");
            const updatePrimarySource=database.prepare("UPDATE transactions SET source = ? WHERE id = ?");
            const createBatch=database.prepare("INSERT INTO import_batches (label) VALUES (?)");
            const linkBatchTransaction=database.prepare("INSERT OR IGNORE INTO import_batch_transactions (batch_id, transaction_id) VALUES (?, ?)");
            const sourceNames=[...new Set(transactions.map(transaction=>String(transaction.source||"").trim()).filter(Boolean))];
            const batchLabel=sourceNames.length===1?sourceNames[0]:sourceNames.length?`${sourceNames.length} statements`:"Imported transactions";
            let insertedCount=0,matchedCount=0,linkedCount=0;
            let batchId=null;
            database.exec("BEGIN");
            try {
              batchId=Number(createBatch.run(batchLabel).lastInsertRowid);
              for (const transaction of transactions) {
                const source = transaction.source || "";
                const amount=/tesla payment/i.test(transaction.description)?-Math.abs(transaction.amount):transaction.amount;
                const fingerprint = transactionFingerprint(transaction.date,transaction.description,amount);
                const descriptionKey=canonicalImportDescription(transaction.description,amount);
                let existing=existingByFingerprint.get(fingerprint);
                if (!existing) {
                  existing=existingByDateAmount.all(transaction.date,amount).find(candidate=>canonicalImportDescription(candidate.description,amount)===descriptionKey);
                }
                if (!existing) {
                  const result=insert.run(transaction.date, transaction.description, "Uncategorised", "", amount, source, fingerprint, transaction.isSubscription?1:0, transaction.isExcluded?1:0);
                  insertedCount+=1;
                  linkBatchTransaction.run(batchId,Number(result.lastInsertRowid));
                } else {
                  matchedCount+=1;
                  linkBatchTransaction.run(batchId,existing.id);
                  if (/\.pdf$/i.test(source) && (!existing.source || /\.(?:csv|xlsx?|ofx)$/i.test(existing.source))) {
                    updatePrimarySource.run(source,existing.id);
                    linkedCount+=1;
                  }
                }
              }
              database.exec("COMMIT");
            } catch (error) {
              database.exec("ROLLBACK");
              throw error;
            }
            const rows = database.prepare("SELECT id, tx_date AS date, description, category, subcategory, amount, source, is_subscription AS isSubscription, is_excluded AS isExcluded, (SELECT COUNT(*) FROM transaction_attachments WHERE transaction_id = transactions.id) AS receiptCount FROM transactions ORDER BY tx_date, id").all();
            const transactionIds=database.prepare("SELECT transaction_id AS id FROM import_batch_transactions WHERE batch_id = ? ORDER BY transaction_id").all(batchId).map(row=>row.id);
            return sendJson(res, {transactions:rows,imported:{inserted:insertedCount,matched:matchedCount,linked:linkedCount},latestImport:{id:batchId,label:batchLabel,transactionIds}}, 201);
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
            if (changes.amount !== undefined) {
              const amount=Number(changes.amount);
              if (!Number.isFinite(amount) || amount===0) return sendJson(res,{error:"Amount must be a non-zero number"},400);
              const transaction=database.prepare("SELECT tx_date AS date, description FROM transactions WHERE id = ?").get(Number(match[1]));
              if (!transaction) return sendJson(res,{error:"Transaction not found"},404);
              database.prepare("UPDATE transactions SET amount = ?, fingerprint = ? WHERE id = ?").run(amount,transactionFingerprint(transaction.date,transaction.description,amount),Number(match[1]));
            }
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
          const database=databaseForLedger(ledgerIdForRequest(req));
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
          if (req.method === "PATCH" && match) {
            const id=Number(match[1]);
            const {name}=JSON.parse((await readBody(req,1024*20)).toString());
            const nextName=String(name||"").trim();
            if (!nextName) return sendJson(res,{error:"Name is required"},400);
            const category=database.prepare("SELECT id, name, parent_id AS parentId FROM categories WHERE id = ?").get(id);
            if (!category) return sendJson(res,{error:"Category not found"},404);
            if (!category.parentId&&["Other","Uncategorised"].includes(category.name)) return sendJson(res,{error:`${category.name} is a system category and cannot be renamed`},400);
            const duplicate=category.parentId
              ? database.prepare("SELECT id FROM categories WHERE name = ? AND parent_id = ? AND id != ?").get(nextName,category.parentId,id)
              : database.prepare("SELECT id FROM categories WHERE name = ? AND parent_id IS NULL AND id != ?").get(nextName,id);
            if (duplicate) return sendJson(res,{error:"That name is already in use"},409);
            database.exec("BEGIN");
            try {
              if (category.parentId) {
                const parent=database.prepare("SELECT name FROM categories WHERE id = ?").get(category.parentId);
                if (parent) database.prepare("UPDATE transactions SET subcategory = ? WHERE category = ? AND subcategory = ?").run(nextName,parent.name,category.name);
              } else {
                database.prepare("UPDATE transactions SET category = ? WHERE category = ?").run(nextName,category.name);
              }
              database.prepare("UPDATE categories SET name = ? WHERE id = ?").run(nextName,id);
              database.exec("COMMIT");
            } catch(error) {
              database.exec("ROLLBACK");
              throw error;
            }
            const rows=database.prepare("SELECT id, name, parent_id AS parentId FROM categories ORDER BY parent_id IS NOT NULL, name").all();
            return sendJson(res,{categories:rows});
          }
          if (req.method === "DELETE" && match) {
            const category=database.prepare("SELECT id, name, parent_id AS parentId FROM categories WHERE id = ?").get(Number(match[1]));
            if (!category) return sendJson(res,{error:"Category not found"},404);
            if (!category.parentId && ["Other","Uncategorised"].includes(category.name)) return sendJson(res,{error:`${category.name} is a system category and cannot be deleted`},400);
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
