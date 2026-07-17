import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Papa from "papaparse";
import { Chart as ChartJS, ArcElement, CategoryScale, LinearScale, BarElement, Tooltip, Legend } from "chart.js";
import { Doughnut, Bar } from "react-chartjs-2";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import {
  ArrowRight, BarChart3, Check, ChevronRight, Download, FileSpreadsheet,
  FileText, Landmark, LockKeyhole, PieChart, RefreshCw, ShieldCheck,
  Sparkles, Star, Target, TrendingDown, UploadCloud, WalletCards, X
} from "lucide-react";
import "./styles.css";
import "./filters.css";

ChartJS.register(ArcElement, CategoryScale, LinearScale, BarElement, Tooltip, Legend);

const CATEGORY_RULES = [
  ["Housing", /rent|mortgage|real estate|property/i],
  ["Groceries", /woolworth|coles|aldi|iga|grocery|supermarket|fresh food/i],
  ["Dining", /restaurant|cafe|coffee|mcdonald|uber eats|doordash|pizza|bakery/i],
  ["Transport", /uber|didi|fuel|petrol|shell|bp |caltex|translink|parking|toll/i],
  ["Utilities", /electric|energy|water|gas bill|internet|telstra|optus|vodafone/i],
  ["Shopping", /amazon|kmart|target|big w|ebay|retail|store/i],
  ["Entertainment", /netflix|spotify|cinema|disney|stan|gaming|ticket/i],
  ["Health", /pharmacy|chemist|doctor|medical|dental|health|physio/i],
  ["Insurance", /insurance|allianz|aami|bupa|medibank/i],
  ["Transfers", /pay anyone|osko payment|payment by authority|transfer to|payid payment received|^RTP |^LP |withdrawal mobile|tfr westpac|american express australia|deposit(?: online)? .*john o.?leary|deposit .*mr john o leary|o leary j \d/i],
  ["Income", /salary|payroll|wage|interest received|refund/i]
];
const COLORS = ["#5F6FFF", "#FF8B6A", "#26B99A", "#F2BC57", "#9A74E8", "#4AA8D8", "#ED6C8C", "#7D8C98", "#A3C95B"];
const fmt = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

const sample = [
  ["2026-05-01","Salary","Income",5200],["2026-05-02","Rent payment","Housing",-1850],
  ["2026-05-03","Woolworths Newstead","Groceries",-184],["2026-05-04","Origin Energy","Utilities",-132],
  ["2026-05-05","Netflix","Entertainment",-23],["2026-05-06","BP Milton","Transport",-86],
  ["2026-05-08","Campos Coffee","Dining",-18],["2026-05-10","Amazon AU","Shopping",-79],
  ["2026-05-12","Coles Toowong","Groceries",-143],["2026-05-14","Telstra","Utilities",-89],
  ["2026-05-18","Uber","Transport",-32],["2026-05-20","Chemist Warehouse","Health",-58],
  ["2026-06-01","Salary","Income",5200],["2026-06-02","Rent payment","Housing",-1850],
  ["2026-06-04","Aldi","Groceries",-156],["2026-06-06","Suncorp Insurance","Insurance",-108],
  ["2026-06-09","Restaurant 1889","Dining",-94],["2026-06-11","Translink","Transport",-50],
  ["2026-06-14","Spotify","Entertainment",-14],["2026-06-16","Kmart","Shopping",-112],
  ["2026-06-20","Woolworths","Groceries",-201],["2026-06-23","Urban Utilities","Utilities",-98],
  ["2026-07-01","Salary","Income",5350],["2026-07-02","Rent payment","Housing",-1850],
  ["2026-07-04","Coles","Groceries",-171],["2026-07-07","Shell Fuel","Transport",-91],
  ["2026-07-10","Dental Care","Health",-180],["2026-07-12","Disney Plus","Entertainment",-18],
  ["2026-07-14","Local Cafe","Dining",-42],["2026-07-16","Amazon AU","Shopping",-68]
].map(([date,description,category,amount]) => ({date,description,category,amount}));

function detectCategory(description, amount) {
  if (CATEGORY_RULES.find(([name, rule]) => name === "Transfers" && rule.test(description))) return "Transfers";
  if (amount > 0) return "Income";
  return CATEGORY_RULES.find(([, rule]) => rule.test(description))?.[0] || "Other";
}
function subscriptionKey(description) {
  return description.toLowerCase().replace(/\b(receipt|date|card|visa purchase|eftpos|aud)\b/g," ").replace(/\d+/g," ").replace(/[^a-z]+/g," ").trim().split(" ").slice(0,4).join(" ");
}
function subscriptionKeys(rows) {
  const merchants = new Map();
  rows.filter(row=>row.amount<0).forEach(row => {
    const key=subscriptionKey(row.description);
    if (!key) return;
    if (!merchants.has(key)) merchants.set(key,[]);
    merchants.get(key).push(row);
  });
  const known=/netflix|spotify|disney|adobe|microsoft|google one|workspace|amazon prime|amznprime|chatgpt|claude|anthropic|render\.com|seats\.aero|subscription|insurance/i;
  return new Set([...merchants].filter(([key,items])=>{
    if (known.test(key)) return true;
    const months=new Set(items.map(item=>item.date.slice(0,7)));
    const amounts=items.map(item=>Math.abs(item.amount));
    const average=amounts.reduce((sum,value)=>sum+value,0)/amounts.length;
    return months.size>=2 && Math.max(...amounts)-Math.min(...amounts)<=Math.max(2,average*.05);
  }).map(([key])=>key));
}
function toNumber(value) {
  if (typeof value === "number") return value;
  const cleaned = String(value ?? "").replace(/[$,\s()]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? (String(value).includes("(") ? -n : n) : 0;
}
const MONEY_AT_END = /-?\$?[\d,]+\.\d{2}/g;
const MONTHS = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
function isoDate(year, month, day) {
  return new Date(Number(year), Number(month), Number(day), 12).toISOString().slice(0,10);
}
function statementYear(text, fallback = new Date().getFullYear()) {
  const years = [...text.matchAll(/\b(20\d{2})\b/g)].map(m=>Number(m[1]));
  return years.find(y=>y>=2020 && y<=new Date().getFullYear()+1) || fallback;
}
function parsePdfStatement(lines) {
  const fullText = lines.join("\n");
  const year = statementYear(fullText);
  const isIng = /Orange Everyday|MORTGAGE SIMPLIFIER/i.test(fullText);
  const isMortgage = /MORTGAGE SIMPLIFIER|Loan statement/i.test(fullText);
  const isWestpac = /Westpac\s+Choice|Customer ID.*BSB/i.test(fullText);
  const isHsbc = /HSBC|EVERYDAY GLOBAL/i.test(fullText);
  const isAmex = /American Express|Membership Number/i.test(fullText);
  const rows = [];
  let currentDate = "";
  let lastRow = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+/g," ").trim();
    if (!line || /opening balance|closing balance|balance brought forward|transaction total|total new|total of new|statement period|statement from|page \d+ of|transaction date|date transaction details/i.test(line)) continue;
    let match;

    if (isIng && (match=line.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(.+)$/))) {
      const amounts = match[4].match(MONEY_AT_END) || [];
      if (!amounts.length) continue;
      const description = match[4].slice(0,match[4].lastIndexOf(amounts[0])).trim();
      let amount = toNumber(amounts[0]);
      if (isMortgage) amount = -Math.abs(amount);
      const category = isMortgage ? "Housing" : detectCategory(description,amount);
      lastRow = {date:isoDate(match[3],MONTHS[match[2].toLowerCase()],match[1]),description,amount,category};
      rows.push(lastRow); continue;
    }

    if (isIng && (match=line.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(.+)$/))) {
      const amounts = match[4].match(MONEY_AT_END) || [];
      if (!amounts.length || /rate changed/i.test(match[4])) continue;
      let description = match[4].slice(0,match[4].lastIndexOf(amounts[0])).trim();
      let amount = toNumber(amounts[0]);
      if (isMortgage) amount = /repayment/i.test(description) ? -Math.abs(amount) : -Math.abs(amount);
      const category = isMortgage ? "Housing" : detectCategory(description,amount);
      lastRow = {date:isoDate(match[3],Number(match[2])-1,match[1]),description,amount,category};
      rows.push(lastRow); continue;
    }

    if (isWestpac && (match=line.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(.+)$/))) {
      const amounts = match[4].match(MONEY_AT_END) || [];
      if (!amounts.length) continue;
      const description = match[4].slice(0,match[4].lastIndexOf(amounts[0])).trim();
      const credit = /deposit|credit|refund|interest paid/i.test(description);
      const amount = (credit?1:-1)*Math.abs(toNumber(amounts.length>1?amounts[amounts.length-2]:amounts[0]));
      lastRow = {date:isoDate(2000+Number(match[3]),Number(match[2])-1,match[1]),description,amount,category:detectCategory(description,amount)};
      rows.push(lastRow); continue;
    }

    if (isHsbc) {
      if ((match=line.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(.+)$/))) {
        currentDate=isoDate(year,MONTHS[match[2].toLowerCase()],match[1]);
        const rest=match[3], amounts=rest.match(MONEY_AT_END)||[];
        if (amounts.length && !/balance/i.test(rest)) {
          const description=rest.slice(0,rest.lastIndexOf(amounts[0])).trim();
          const credit=/HSBC Fortem|Expense Claims|RTP |LP |deposit|refund|cashback/i.test(description);
          const amount=(credit?1:-1)*Math.abs(toNumber(amounts[0]));
          lastRow={date:currentDate,description,amount,category:detectCategory(description,amount)}; rows.push(lastRow);
        }
        continue;
      }
      if (currentDate && /^(EFTPOS|RTP |LP |HSBC Fortem|Expense Claims|ATM |Fee |Interest )/i.test(line) && !/Cashback - Enjoy|2% Cashback/i.test(line)) {
        const amounts=line.match(MONEY_AT_END)||[];
        if (amounts.length) {
          const description=line.slice(0,line.lastIndexOf(amounts[0])).trim();
          const credit=/HSBC Fortem|Expense Claims|RTP |LP |deposit|refund/i.test(description);
          const amount=(credit?1:-1)*Math.abs(toNumber(amounts[0]));
          lastRow={date:currentDate,description,amount,category:detectCategory(description,amount)}; rows.push(lastRow);
        }
        continue;
      }
    }

    if (isAmex && (match=line.match(/^([A-Za-z]{3,9})\s+(\d{1,2})\s+(.+)$/))) {
      const month=MONTHS[match[1].slice(0,3).toLowerCase()];
      const amounts=match[3].match(MONEY_AT_END)||[];
      if (month===undefined || !amounts.length || /statement|interest rate|payment due/i.test(match[3])) continue;
      const description=match[3].slice(0,match[3].lastIndexOf(amounts[0])).trim();
      const amount=-Math.abs(toNumber(amounts[amounts.length-1]));
      lastRow={date:isoDate(year,month,match[2]),description,amount,category:detectCategory(description,amount)};
      rows.push(lastRow); continue;
    }
    if (isAmex && /^CR$/i.test(line) && lastRow) {
      lastRow.amount=Math.abs(lastRow.amount);
      lastRow.category=detectCategory(lastRow.description,lastRow.amount);
    }
  }
  return rows.filter(r=>r.description && Math.abs(r.amount)>0);
}
function normaliseRows(rows) {
  return rows.map((row) => {
    const keys = Object.keys(row);
    const find = (...terms) => keys.find(k => terms.some(t => k.toLowerCase().includes(t)));
    const dateKey = find("date", "posted");
    const descKey = find("description", "details", "merchant", "narration", "memo");
    const amountKey = find("amount", "value");
    const debitKey = find("debit", "withdrawal");
    const creditKey = find("credit", "deposit");
    let amount = amountKey ? toNumber(row[amountKey]) : toNumber(row[creditKey]) - toNumber(row[debitKey]);
    const description = String(row[descKey] ?? "Transaction").trim();
    return {
      date: new Date(row[dateKey] ?? Date.now()).toISOString().slice(0,10),
      description,
      category: detectCategory(description, amount),
      amount
    };
  }).filter(r => r.amount !== 0 && !Number.isNaN(new Date(r.date).getTime()));
}
async function parseFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "csv") {
    return new Promise((resolve, reject) => Papa.parse(file, { header:true, skipEmptyLines:true, complete:r => resolve(normaliseRows(r.data)), error:reject }));
  }
  if (["xls","xlsx"].includes(ext)) {
    if (ext === "xls") throw new Error("Legacy .xls files are not supported locally. Save the file as .xlsx or CSV first.");
    const { default: ExcelJS } = await import("exceljs");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await file.arrayBuffer());
    const sheet = book.worksheets[0];
    const headers = sheet.getRow(1).values.slice(1).map(String);
    const rows = [];
    sheet.eachRow((row, index) => {
      if (index === 1) return;
      rows.push(Object.fromEntries(headers.map((header, i) => [header, row.getCell(i + 1).value])));
    });
    return normaliseRows(rows);
  }
  if (ext === "ofx") {
    const text = await file.text();
    const blocks = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || [];
    return blocks.map(block => {
      const get = tag => block.match(new RegExp(`<${tag}>([^<\\r\\n]+)`,"i"))?.[1]?.trim() || "";
      const amount = toNumber(get("TRNAMT"));
      const description = get("NAME") || get("MEMO") || "Transaction";
      return { date:get("DTPOSTED").slice(0,8).replace(/(....)(..)(..)/,"$1-$2-$3"), description, amount, category:detectCategory(description,amount) };
    });
  }
  if (ext === "pdf") {
    const response = await fetch("/api/parse-pdf", {
      method:"POST",
      headers:{"Content-Type":"application/pdf"},
      body:await file.arrayBuffer()
    });
    if (!response.ok) {
      const detail = await response.json().catch(()=>({}));
      throw new Error(detail.error || "The local PDF reader could not extract this statement.");
    }
    const { lines } = await response.json();
    const rows = parsePdfStatement(lines);
    if (!rows.length) throw new Error("This PDF layout could not be read reliably. Try exporting the statement as CSV, Excel or OFX.");
    return rows;
  }
  throw new Error("Unsupported file format. Use CSV, XLSX, OFX or PDF.");
}

function App() {
  const [transactions, setTransactions] = useState([]);
  const [fileNames, setFileNames] = useState([]);
  const [view, setView] = useState("landing");
  const [tab, setTab] = useState("analysis");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [customCategories,setCustomCategories] = useState([]);
  const input = useRef();

  useEffect(() => {
    fetch("/api/transactions")
      .then(response => response.ok ? response.json() : Promise.reject())
      .then(({transactions:stored}) => {
        if (stored?.length) {
          setTransactions(stored);
          setFileNames([...new Set(stored.map(row=>row.source).filter(Boolean))]);
          setView("dashboard");
        }
      })
      .catch(()=>{});
    fetch("/api/categories").then(response=>response.json()).then(data=>setCustomCategories(data.categories||[])).catch(()=>{});
  }, []);

  const availableMonths = useMemo(() => [...new Set(transactions.map(t=>t.date.slice(0,7)))].sort(), [transactions]);
  const filteredTransactions = useMemo(() => transactions.filter(t => {
    const month = t.date.slice(0,7);
    return (!dateFrom || month>=dateFrom) && (!dateTo || month<=dateTo);
  }), [transactions,dateFrom,dateTo]);
  const analysis = useMemo(() => {
    const expenses = filteredTransactions.filter(t=>t.amount<0 && t.category!=="Transfers");
    const income = filteredTransactions.filter(t=>t.amount>0 && t.category!=="Transfers");
    const byCategory = {};
    expenses.forEach(t => byCategory[t.category]=(byCategory[t.category]||0)+Math.abs(t.amount));
    const months = [...new Set(filteredTransactions.map(t=>t.date.slice(0,7)))].sort();
    const monthly = months.map(m => ({
      month:m,
      expense:expenses.filter(t=>t.date.startsWith(m)).reduce((s,t)=>s+Math.abs(t.amount),0),
      income:income.filter(t=>t.date.startsWith(m)).reduce((s,t)=>s+t.amount,0)
    }));
    return {
      expenses: expenses.reduce((s,t)=>s+Math.abs(t.amount),0),
      income: income.reduce((s,t)=>s+t.amount,0),
      byCategory,
      months,
      monthly,
      average: months.length ? expenses.reduce((s,t)=>s+Math.abs(t.amount),0)/months.length : 0
    };
  }, [filteredTransactions]);

  async function handleFiles(files) {
    const picked = [...files];
    if (!picked.length) return;
    setLoading(true); setError("");
    try {
      const sets = await Promise.all(picked.map(async file => (await parseFile(file)).map(transaction=>({...transaction,source:file.name}))));
      const merged = sets.flat().sort((a,b)=>a.date.localeCompare(b.date));
      if (!merged.length) throw new Error("No transactions were found. Check that your file has date, description and amount columns.");
      const response = await fetch("/api/transactions", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({transactions:merged})});
      if (!response.ok) throw new Error("Transactions were read but could not be saved to the local database.");
      const { transactions:stored } = await response.json();
      setTransactions(stored); setFileNames([...new Set(stored.map(row=>row.source).filter(Boolean))]); setView("dashboard");
    } catch(e) {
      const message = String(e?.message || "");
      setError(
        /importing a module|module script|dynamically imported/i.test(message)
          ? "This file reader is not compatible with the embedded browser. Export the statement as CSV or OFX and try again."
          : message || "The statement could not be imported. Try a CSV or OFX export from your bank."
      );
    }
    finally { setLoading(false); }
  }
  async function exportExcel() {
    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    const txSheet = wb.addWorksheet("Transactions");
    txSheet.columns = [{header:"Date",key:"date",width:14},{header:"Description",key:"description",width:34},{header:"Category",key:"category",width:20},{header:"Amount",key:"amount",width:14}];
    txSheet.addRows(filteredTransactions);
    const budget = Object.entries(analysis.byCategory).map(([Category,Total])=>({Category,MonthlyAverage:Total/analysis.months.length,SuggestedBudget:Math.ceil((Total/analysis.months.length)*1.05/10)*10}));
    const budgetSheet = wb.addWorksheet("Monthly Budget");
    budgetSheet.columns = [{header:"Category",key:"Category",width:22},{header:"Monthly Average",key:"MonthlyAverage",width:18},{header:"Suggested Budget",key:"SuggestedBudget",width:18}];
    budgetSheet.addRows(budget);
    [txSheet,budgetSheet].forEach(sheet => { sheet.getRow(1).font={bold:true,color:{argb:"FFFFFFFF"}}; sheet.getRow(1).fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF17202C"}}; });
    const blob = new Blob([await wb.xlsx.writeBuffer()],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href=href; link.download="ledgerly-budget.xlsx"; link.click(); URL.revokeObjectURL(href);
  }
  function exportPdf() {
    const doc = new jsPDF();
    doc.setFontSize(22); doc.text("Ledgerly spending report",14,20);
    doc.setFontSize(10); doc.setTextColor(100); doc.text(`Generated ${new Date().toLocaleDateString("en-AU")} • ${filteredTransactions.length} transactions`,14,28);
    doc.setTextColor(25); doc.setFontSize(13); doc.text(`Average monthly spend: ${fmt.format(analysis.average)}`,14,40);
    autoTable(doc,{startY:48,head:[["Category","Total","Monthly average"]],body:Object.entries(analysis.byCategory).sort((a,b)=>b[1]-a[1]).map(([c,v])=>[c,fmt.format(v),fmt.format(v/analysis.months.length)])});
    doc.save("ledgerly-report.pdf");
  }
  async function updateCategory(row,value) {
    if (row.id) {
      const response = await fetch(`/api/transactions/${row.id}`, {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({category:value,subcategory:""})});
      if (!response.ok) throw new Error("Category could not be saved");
    }
    setTransactions(current => current.map(transaction => transaction===row ? {...transaction,category:value,subcategory:""} : transaction));
  }
  async function updateSubcategory(row,value) {
    if (row.id) await fetch(`/api/transactions/${row.id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({subcategory:value})});
    setTransactions(current=>current.map(transaction=>transaction===row?{...transaction,subcategory:value}:transaction));
  }
  async function addCategory(name,parentId=null) {
    const response=await fetch("/api/categories",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,parentId})});
    const data=await response.json();
    if (!response.ok) throw new Error(data.error||"Could not add category");
    setCustomCategories(data.categories);
  }
  async function updateSubscription(row,value) {
    if (row.id) {
      const response = await fetch(`/api/transactions/${row.id}`, {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({isSubscription:value})});
      if (!response.ok) throw new Error("Subscription flag could not be saved");
    }
    setTransactions(current => current.map(transaction => transaction===row ? {...transaction,isSubscription:value?1:0} : transaction));
  }
  if (view === "dashboard") return <Dashboard {...{transactions:filteredTransactions,totalTransactions:transactions.length,updateCategory,updateSubcategory,updateSubscription,customCategories,addCategory,analysis,tab,setTab,fileNames,exportExcel,exportPdf,availableMonths,dateFrom,setDateFrom,dateTo,setDateTo,onReset:()=>{setView("landing");setTransactions([]);setDateFrom("");setDateTo("")}}}/>;
  return <Landing {...{input,handleFiles,loading,error,dragging,setDragging,onSample:()=>{setTransactions(sample);setFileNames(["Sample statement"]);setView("dashboard")}}}/>;
}

function Brand() {
  return <div className="brand"><span className="brandmark"><BarChart3 size={20}/></span><span>Ledgerly</span></div>;
}
function Landing({input,handleFiles,loading,error,dragging,setDragging,onSample}) {
  return <div className="landing">
    <nav><Brand/><div className="navlinks"><a href="#how">How it works</a><a href="#privacy">Privacy</a><button className="nav-cta" onClick={()=>input.current.click()}>Start analysing <ArrowRight size={16}/></button></div></nav>
    <main>
      <section className="hero">
        <div className="eyebrow"><Sparkles size={14}/> Your money, made clear</div>
        <h1>Turn statements into<br/><em>a budget that works.</em></h1>
        <p className="hero-copy">Upload your bank transactions and get a clear picture of where your money goes—plus a realistic monthly budget—in seconds.</p>
        <div className={`upload-card ${dragging?"dragging":""}`} onDragOver={e=>{e.preventDefault();setDragging(true)}} onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);handleFiles(e.dataTransfer.files)}}>
          <input ref={input} type="file" hidden multiple accept=".csv,.xlsx,.ofx,.pdf" onChange={e=>handleFiles(e.target.files)}/>
          <div className="upload-icon"><UploadCloud size={30}/></div>
          <h3>{loading?"Reading your transactions…":"Drop your statements here"}</h3>
          <p>or <button className="text-button" onClick={()=>input.current.click()}>choose files</button> from your device</p>
          <span>CSV, Excel, OFX and text-based PDF supported</span>
          {loading && <div className="progress"><i/></div>}
        </div>
        {error && <div className="error"><X size={16}/>{error}</div>}
        <button className="sample-link" onClick={onSample}>Explore with sample data <ChevronRight size={16}/></button>
        <div className="trust-row"><span><ShieldCheck size={18}/> Processed in your browser</span><span><LockKeyhole size={18}/> Nothing stored</span><span><Check size={18}/> No sign-up</span></div>
      </section>
      <section className="preview">
        <div className="float-card card-one"><span>Monthly breathing room</span><strong>$1,436</strong><small><TrendingDown size={14}/> 8% better than last month</small></div>
        <div className="orbit"><div className="orbit-center"><PieChart size={40}/><strong>Know every dollar</strong><span>without the spreadsheet headache</span></div></div>
        <div className="float-card card-two"><span>Top category</span><strong>Housing</strong><div className="mini-bar"><i/></div><small>36% of monthly spending</small></div>
      </section>
    </main>
    <section className="steps" id="how">
      <div className="section-heading"><span>FROM FILES TO FORESIGHT</span><h2>Clarity in three simple steps.</h2></div>
      <div className="step-grid">
        <Step n="01" icon={<UploadCloud/>} title="Bring your statements" text="Add exports from any bank. Combine accounts and months in one analysis."/>
        <Step n="02" icon={<Sparkles/>} title="We organise the noise" text="Transactions are cleaned, classified and grouped into useful categories."/>
        <Step n="03" icon={<Target/>} title="Build a better month" text="See patterns, adjust category targets and export a practical budget."/>
      </div>
    </section>
    <section className="privacy" id="privacy"><ShieldCheck size={34}/><div><h3>Your financial data stays yours.</h3><p>Ledgerly analyses files locally in your browser. Your statement data is never uploaded or retained.</p></div></section>
  </div>;
}
function Step({n,icon,title,text}) { return <article className="step"><span className="step-number">{n}</span><div className="step-icon">{icon}</div><h3>{title}</h3><p>{text}</p></article> }

function Dashboard({transactions,totalTransactions,updateCategory,updateSubcategory,updateSubscription,customCategories,addCategory,analysis,tab,setTab,fileNames,exportExcel,exportPdf,availableMonths,dateFrom,setDateFrom,dateTo,setDateTo,onReset}) {
  const cats = Object.entries(analysis.byCategory).sort((a,b)=>b[1]-a[1]);
  const donut = {labels:cats.map(x=>x[0]),datasets:[{data:cats.map(x=>x[1]),backgroundColor:COLORS,borderWidth:0,hoverOffset:6}]};
  const bars = {labels:analysis.monthly.map(x=>new Date(x.month+"-02").toLocaleDateString("en-AU",{month:"short"})),datasets:[{label:"Income",data:analysis.monthly.map(x=>x.income),backgroundColor:"#B9E9DE",borderRadius:7},{label:"Spending",data:analysis.monthly.map(x=>x.expense),backgroundColor:"#6574F7",borderRadius:7}]};
  const monthCount = Math.max(analysis.months.length,1);
  return <div className="app-shell">
    <aside><Brand/><div className="side-files"><span>ANALYSIS</span><button className={tab==="analysis"?"active":""} onClick={()=>setTab("analysis")}><PieChart size={18}/>Spending analysis</button><button className={tab==="budget"?"active":""} onClick={()=>setTab("budget")}><WalletCards size={18}/>Monthly budget</button><button className={tab==="transactions"?"active":""} onClick={()=>setTab("transactions")}><FileSpreadsheet size={18}/>Transactions</button><button className={tab==="categorise"?"active":""} onClick={()=>setTab("categorise")}><Target size={18}/>Categorise</button></div><div className="file-box"><Landmark size={18}/><div><strong>{fileNames.length} source{fileNames.length!==1?"s":""}</strong><span>{transactions.length}{transactions.length!==totalTransactions?` of ${totalTransactions}`:""} transactions</span></div></div><button className="reset" onClick={onReset}><RefreshCw size={16}/>New analysis</button></aside>
    <div className="dash-main">
      <header><div><span className="overline">YOUR MONEY SNAPSHOT</span><h1>{tab==="analysis"?"Spending analysis":tab==="budget"?"Monthly budget":tab==="categorise"?"Categorise transactions":"Transactions"}</h1></div><div className="header-tools"><div className="date-filters"><label><span>From</span><select value={dateFrom} onChange={e=>{setDateFrom(e.target.value);if(dateTo&&e.target.value>dateTo)setDateTo(e.target.value)}}><option value="">First month</option>{availableMonths.map(month=><option key={month} value={month}>{new Date(month+"-02").toLocaleDateString("en-AU",{month:"short",year:"numeric"})}</option>)}</select></label><label><span>To</span><select value={dateTo} onChange={e=>{setDateTo(e.target.value);if(dateFrom&&e.target.value<dateFrom)setDateFrom(e.target.value)}}><option value="">Latest month</option>{availableMonths.map(month=><option key={month} value={month}>{new Date(month+"-02").toLocaleDateString("en-AU",{month:"short",year:"numeric"})}</option>)}</select></label></div><div className="actions"><button onClick={exportPdf}><FileText size={16}/>PDF</button><button className="primary" onClick={exportExcel}><Download size={16}/>Export Excel</button></div></div></header>
      {tab==="analysis" && <><div className="metric-grid"><Metric label="Average monthly spend" value={fmt.format(analysis.average)} note={`${analysis.months.length} month view`} icon={<TrendingDown/>}/><Metric label="Average monthly income" value={fmt.format(analysis.income/monthCount)} note={`${fmt.format(analysis.income-analysis.expenses)} net total`} icon={<WalletCards/>}/><Metric label="Transactions" value={transactions.length} note={`${cats.length} spending categories`} icon={<FileSpreadsheet/>}/></div>
      <div className="chart-grid"><section className="panel"><div className="panel-title"><div><span>SPENDING MIX</span><h3>Where your money goes</h3></div></div><div className="donut-wrap"><Doughnut data={donut} options={{cutout:"68%",plugins:{legend:{display:false}}}}/><div className="donut-label"><strong>{fmt.format(analysis.expenses)}</strong><span>total spent</span></div></div><div className="legend">{cats.slice(0,6).map(([c,v],i)=><div key={c}><i style={{background:COLORS[i%COLORS.length]}}/><span>{c}</span><strong>{Math.round(v/analysis.expenses*100)}%</strong></div>)}</div></section>
      <section className="panel wide"><div className="panel-title"><div><span>MONTH BY MONTH</span><h3>Income and spending</h3></div></div><div className="bar-wrap"><Bar data={bars} options={{maintainAspectRatio:false,plugins:{legend:{position:"bottom",labels:{usePointStyle:true,boxWidth:8}}},scales:{x:{grid:{display:false}},y:{border:{display:false},grid:{color:"#EEF0F5"},ticks:{callback:v=>"$"+v/1000+"k"}}}}}/></div></section></div>
      <section className="panel table-panel"><div className="panel-title"><div><span>CATEGORY DETAIL</span><h3>Your spending, ranked</h3></div></div><CategoryTable cats={cats} months={monthCount} total={analysis.expenses}/></section></>}
      {tab==="budget" && <Budget cats={cats} months={monthCount} income={analysis.income/monthCount}/>}
      {tab==="transactions" && <Transactions rows={transactions} onCategoryChange={updateCategory}/>}
      {tab==="categorise" && <Categorise rows={transactions} categories={customCategories} onAddCategory={addCategory} onCategoryChange={updateCategory} onSubcategoryChange={updateSubcategory} onSubscriptionChange={updateSubscription}/>}
    </div>
  </div>;
}
function Metric({label,value,note,icon}) { return <section className="metric"><div className="metric-icon">{icon}</div><span>{label}</span><strong>{value}</strong><small>{note}</small></section> }
function CategoryTable({cats,months,total}) { return <div className="data-table"><div className="table-row head"><span>Category</span><span>Total</span><span>Monthly avg.</span><span>Share</span></div>{cats.map(([c,v],i)=><div className="table-row" key={c}><span><i style={{background:COLORS[i%COLORS.length]}}/>{c}</span><strong>{fmt.format(v)}</strong><span>{fmt.format(v/months)}</span><span>{Math.round(v/total*100)}%</span></div>)}</div> }
function Budget({cats,months,income}) {
  const initial = Object.fromEntries(cats.map(([c,v])=>[c,Math.ceil((v/months)*1.05/10)*10]));
  const [targets,setTargets] = useState(initial);
  const total = Object.values(targets).reduce((a,b)=>a+Number(b),0);
  return <><div className="budget-hero"><div><span>RECOMMENDED PLAN</span><h2>Give every dollar a job.</h2><p>Targets start 5% above your recent average, giving you a realistic buffer.</p></div><div className="budget-ring"><span>Left after budget</span><strong className={income-total<0?"negative":""}>{fmt.format(income-total)}</strong><small>of {fmt.format(income)} income</small></div></div><section className="panel budget-panel"><div className="table-row budget-head"><span>Category</span><span>Recent average</span><span>Monthly target</span><span>Difference</span></div>{cats.map(([c,v],i)=>{const avg=v/months,diff=targets[c]-avg;return <div className="table-row budget-row" key={c}><span><i style={{background:COLORS[i%COLORS.length]}}/>{c}</span><span>{fmt.format(avg)}</span><label><b>$</b><input type="number" value={targets[c]} onChange={e=>setTargets({...targets,[c]:e.target.value})}/></label><span className={diff<0?"saving":""}>{diff>=0?"+":""}{fmt.format(diff)}</span></div>})}<div className="budget-total"><span>Total monthly budget</span><strong>{fmt.format(total)}</strong></div></section></>;
}
function Transactions({rows,onCategoryChange}) {
  const recurring=subscriptionKeys(rows);
  return <section className="panel transactions"><p className="helper">Review the detected categories. Changes update your analysis instantly.</p><div className="table-row tx-head"><span>Date</span><span>Description</span><span>Category</span><span>Amount</span></div>{rows.slice().reverse().map((r,reverseIndex)=>{const subscription=r.isSubscription||recurring.has(subscriptionKey(r.description));return <div className={`table-row tx-row ${subscription?"subscription-row":""}`} key={`${r.date}-${r.description}-${reverseIndex}`}><span>{new Date(r.date+"T00:00").toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"})}</span><strong>{r.description}{subscription&&<small className="subscription-pill"><Star size={10}/>Subscription</small>}</strong><select value={r.category} onChange={e=>onCategoryChange(r,e.target.value)}>{[...CATEGORY_RULES.map(x=>x[0]),"Other"].filter((v,i,a)=>a.indexOf(v)===i).map(c=><option key={c}>{c}</option>)}</select><span className={r.amount>0?"positive":""}>{r.amount>0?"+":""}{fmt.format(r.amount)}</span></div>})}</section>
}
function Categorise({rows,categories:categoryRecords,onAddCategory,onCategoryChange,onSubcategoryChange,onSubscriptionChange}) {
  const [search,setSearch] = useState("");
  const [showCategory,setShowCategory] = useState("All");
  const [selected,setSelected] = useState(new Set());
  const [bulkCategory,setBulkCategory] = useState("Other");
  const [subscriptionsOnly,setSubscriptionsOnly] = useState(false);
  const [newCategory,setNewCategory]=useState("");
  const [newSubcategory,setNewSubcategory]=useState("");
  const [parentCategory,setParentCategory]=useState("");
  const parents=categoryRecords.filter(category=>!category.parentId);
  const categories=parents.map(category=>category.name);
  const childrenFor=name=>{const parent=parents.find(category=>category.name===name);return parent?categoryRecords.filter(category=>category.parentId===parent.id):[]};
  const recurring=subscriptionKeys(rows);
  const isSubscription=row=>Boolean(row.isSubscription)||recurring.has(subscriptionKey(row.description));
  const visible = rows.filter(row => (showCategory==="All" || row.category===showCategory) && (!search || row.description.toLowerCase().includes(search.toLowerCase())) && (!subscriptionsOnly||isSubscription(row)));
  function toggle(id) {
    setSelected(current => { const next=new Set(current); next.has(id)?next.delete(id):next.add(id); return next; });
  }
  async function applyBulk() {
    const picked=rows.filter(row=>selected.has(row.id || `${row.date}-${row.description}`));
    await Promise.all(picked.map(row=>onCategoryChange(row,bulkCategory)));
    setSelected(new Set());
  }
  async function createCategory(event) {
    event.preventDefault();
    if (!newCategory.trim()) return;
    await onAddCategory(newCategory.trim());
    setNewCategory("");
  }
  async function createSubcategory(event) {
    event.preventDefault();
    const parent=parents.find(category=>String(category.id)===parentCategory);
    if (!parent||!newSubcategory.trim()) return;
    await onAddCategory(newSubcategory.trim(),parent.id);
    setNewSubcategory("");
  }
  return <section className="panel categorise-page">
    <div className="category-manager"><div><span>CATEGORY SETUP</span><h3>Create categories and subcategories</h3></div><form onSubmit={createCategory}><input value={newCategory} onChange={e=>setNewCategory(e.target.value)} placeholder="New category"/><button>Add category</button></form><form onSubmit={createSubcategory}><select value={parentCategory} onChange={e=>setParentCategory(e.target.value)}><option value="">Parent category</option>{parents.map(category=><option key={category.id} value={category.id}>{category.name}</option>)}</select><input value={newSubcategory} onChange={e=>setNewSubcategory(e.target.value)} placeholder="New subcategory"/><button>Add subcategory</button></form></div>
    <div className="category-toolbar"><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search merchant or description"/><select value={showCategory} onChange={e=>setShowCategory(e.target.value)}><option>All</option>{categories.map(category=><option key={category}>{category}</option>)}</select><label className="subscription-filter"><input type="checkbox" checked={subscriptionsOnly} onChange={e=>setSubscriptionsOnly(e.target.checked)}/><Star size={14}/>Subscriptions only</label><div className="bulk-tools"><span>{selected.size} selected</span><select value={bulkCategory} onChange={e=>setBulkCategory(e.target.value)}>{categories.map(category=><option key={category}>{category}</option>)}</select><button disabled={!selected.size} onClick={applyBulk}>Apply category</button></div></div>
    <div className="category-list"><div className="category-row category-head"><span></span><span>Date</span><span>Description</span><span>Amount</span><span>Category</span><span>Subcategory</span><span>Subscription</span></div>{visible.slice().reverse().map((row,index)=>{const key=row.id || `${row.date}-${row.description}`,subscription=isSubscription(row),children=childrenFor(row.category);return <div className={`category-row ${subscription?"subscription-row":""}`} key={`${key}-${index}`}><input type="checkbox" checked={selected.has(key)} onChange={()=>toggle(key)}/><span>{new Date(row.date+"T00:00").toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"})}</span><strong>{row.description}</strong><span className={row.amount>0?"positive":""}>{row.amount>0?"+":""}{fmt.format(row.amount)}</span><select value={row.category} onChange={e=>onCategoryChange(row,e.target.value)}>{categories.map(category=><option key={category}>{category}</option>)}</select><select value={row.subcategory||""} onChange={e=>onSubcategoryChange(row,e.target.value)} disabled={!children.length}><option value="">{children.length?"No subcategory":"None available"}</option>{children.map(child=><option key={child.id}>{child.name}</option>)}</select><button className={`subscription-toggle ${row.isSubscription?"active":""}`} onClick={()=>onSubscriptionChange(row,!row.isSubscription)}><Star size={14}/>{row.isSubscription?"Marked":"Mark"}</button></div>})}</div>
  </section>;
}
createRoot(document.getElementById("root")).render(<App/>);
