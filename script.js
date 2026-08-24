const CATS = ["#2a78d6","#eb6834","#1baf7a","#eda100","#e87ba4","#008300","#4a3aa7","#e34948"];

function num(v){ return (v===null||v===undefined||isNaN(v)) ? 0 : +v; }
function pct(v){ return (num(v)*100).toFixed(1)+"%"; }
function pct0(v){ return (num(v)*100).toFixed(0)+"%"; }

function riskClass(r){
  if(!r) return "warning";
  r = r.toUpperCase();
  if(r.includes("BOM")||r.includes("OK")) return "good";
  if(r.includes("CRÍT")||r.includes("CRIT")) return "critical";
  return "warning";
}
function coletaClass(s){
  if(!s) return "warning";
  s = s.toUpperCase();
  if(s.includes("COLETOU")) return "good";
  if(s.includes("3+")) return "critical";
  return "warning";
}

// normalize rows
// ==================== FONTE DE DADOS AO VIVO ====================
// Cole aqui a URL do Web App do Apps Script (Deploy > New deployment > Web app).
// Veja instruções completas no arquivo DEPLOY.md.
const API_URL = "https://script.google.com/a/macros/shopee.com/s/AKfycbyAlO5tzyNj2xxOjZDRkT8GNov5h9HwEjaRHOvPypVwYkymldkqCXbY15lSIduc1UNTNQ/exec";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // busca dados novos a cada 5 minutos

let DATA = [];
let filters = { resp:"", subreg:"", cidade:"", statuscoleta:"", risco:"" };

function normalizeRows(raw){
  return raw.map(r => ({
    dop: r["DOP"], resp: r["RESPONSÁVEL"]||"Não informado", agencia: r["AGÊNCIA"]||r["NOME FANTASIA"]||"—",
    fantasia: r["NOME FANTASIA"]||r["AGÊNCIA"]||"—",
    cidade: r["CIDADE"]||"Não informado", estado: r["ESTADO"]||"Não informado", subreg: r["SUB-REGIONAL"]||"Não informado",
    estacao: r["CÓDIGO DA ESTAÇÃO"]||"Não informado",
    backlog: num(r["BACKLOG"]), backlogOps: num(r["BACKLOG TOTAL (OPS)"]),
    inbound: num(r["INBOUND"]), outbound: num(r["OUTBOUND"]),
    fifoHojeFlag: num(r["FIFO HOJE"]), sameDayFlag: num(r["SAME DAY"]),
    fifoSemana: num(r["FIFO SEMANA"]), sameDaySemana: num(r["SAME DAY SEMANA"]),
    lost: num(r["LOST"]), pctAtrasados: num(r["% ATRASADOS"]),
    perdasQtd: num(r["QTD PACOTES PERDIDOS"]), perdasValor: num(r["VALOR PERDIDO (R$)"]),
    backlogEnvelhecido: num(r["BACKLOG ENVELHECIDO"]), totalAtrasados: num(r["TOTAL ATRASADOS"]),
    statusColeta: r["STATUS COLETA"]||"—", horasSemColeta: num(r["HORAS SEM COLETA"]),
    agingSemColeta: num(r["AGING SEM COLETA"]), ultimaColeta: r["ULTIMA COLETA"],
    score: num(r["SCORE OPERACIONAL"]), risco: r["RISCO OPERACIONAL"]||"—",
    status: r["STATUS"]||"—", maturacao: r["MATURAÇÃO"]||"—", tevecoleta: r["TEVE_COLETA"]||"—",
    data: r["DATA"]
  }));
}

function uniq(field){ return [...new Set(DATA.map(d=>d[field]).filter(v=>v && v!=="—"))].sort(); }

function populateSelect(id, values){
  const sel = document.getElementById(id);
  const current = sel.value;
  const emptyLabel = sel.dataset.empty || "Todos";
  sel.innerHTML = `<option value="">${emptyLabel}</option>`;
  values.forEach(v=>{ const o=document.createElement("option"); o.value=v; o.textContent=v; sel.appendChild(o); });
  if(values.includes(current)) sel.value = current;
}

function populateFilters(){
  populateSelect("f-resp", uniq("resp"));
  populateSelect("f-subreg", uniq("subreg"));
  populateSelect("f-cidade", uniq("cidade"));
  populateSelect("f-statuscoleta", uniq("statusColeta"));
  populateSelect("f-risco", uniq("risco"));
  ["resp","subreg","cidade","statuscoleta","risco"].forEach(k=>{
    if(!document.getElementById("f-"+k).value) filters[k] = "";
  });
}

["resp","subreg","cidade","statuscoleta","risco"].forEach(k=>{
  document.getElementById("f-"+k).addEventListener("change", e=>{ filters[k]=e.target.value; renderAll(); });
});

function setLiveStatus(ok, message){
  const dot = document.getElementById("live-dot");
  const chip = document.getElementById("update-chip");
  dot.classList.toggle("stale", !ok);
  chip.lastChild.textContent = " " + message;
}

// Busca dados via <iframe> escondido + postMessage, em vez de
// fetch() ou JSONP. O Web App do Apps Script fica restrito a
// "Qualquer pessoa dentro da Shopee Mobile" (o Workspace não libera
// "Anyone" público). Tanto fetch() quanto JSONP (tag <script>)
// cross-origin acabam bloqueados pelo Chrome (proteção "ORB") quando
// a resposta passa pelo redirecionamento interno do Google. Um
// <iframe> é uma navegação de página normal — não sofre esse
// bloqueio — e a própria página carregada dentro dele (ver
// WebApp.gs) manda os dados de volta via postMessage.
function fetchViaIframe(url, timeoutMs){
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    let settled = false;
    let timer;
    // rid identifica esta chamada específica — evita que duas buscas
    // concorrentes (ex: dados principais + histórico, disparadas quase
    // ao mesmo tempo) acabem resolvendo com a resposta uma da outra.
    const rid = "r" + Date.now() + "_" + Math.random().toString(36).slice(2);
    function onMessage(ev){
      if(!ev.data || ev.data.source !== "bi-operacional-shopee") return;
      if(ev.data.rid !== rid) return;
      if(settled) return;
      settled = true;
      cleanup();
      if(ev.data.ok) resolve(ev.data.payload);
      else reject(new Error(ev.data.error || "Erro desconhecido ao buscar dados"));
    }
    function cleanup(){
      window.removeEventListener("message", onMessage);
      if(iframe.parentNode) iframe.parentNode.removeChild(iframe);
      clearTimeout(timer);
    }
    window.addEventListener("message", onMessage);
    timer = setTimeout(() => {
      if(settled) return;
      settled = true;
      cleanup();
      reject(new Error("Tempo esgotado ao buscar dados. Confira se você está logada com sua conta @shopee.com."));
    }, timeoutMs || 20000);
    iframe.onerror = () => {
      if(settled) return;
      settled = true;
      cleanup();
      reject(new Error("Falha ao carregar o iframe de dados"));
    };
    const sep = url.indexOf("?") >= 0 ? "&" : "?";
    iframe.src = url + sep + "embed=1&rid=" + rid + "&_=" + Date.now();
    document.body.appendChild(iframe);
  });
}

async function loadData(showOverlay){
  const overlay = document.getElementById("loading-overlay");
  const banner = document.getElementById("error-banner");
  if(showOverlay) overlay.style.display = "flex";
  try {
    if(API_URL.indexOf("COLOQUE_AQUI") !== -1){
      throw new Error("API_URL ainda não configurada em script.js");
    }
    const json = await fetchViaIframe(API_URL, 20000);
    const rows = Array.isArray(json) ? json : (json.rows || []);
    DATA = normalizeRows(rows);
    banner.style.display = "none";
    populateFilters();
    renderAll();
    const stamp = json.updatedAt ? fmtDate(json.updatedAt) : new Date().toLocaleTimeString("pt-BR");
    setLiveStatus(true, "Sincronizado às " + stamp);
  } catch(err){
    console.error(err);
    banner.style.display = "block";
    banner.textContent = "⚠ Não foi possível atualizar os dados agora (" + err.message + "). " + (DATA.length ? "Mostrando a última versão carregada." : "Confira a API_URL em script.js.");
    setLiveStatus(false, "Falha na sincronização");
    if(DATA.length){ populateFilters(); renderAll(); }
  } finally {
    overlay.style.display = "none";
  }
}

document.getElementById("refresh-btn").addEventListener("click", ()=> loadData(true));

// ==================== HISTÓRICO — INBOUND PÓS-FECHAMENTO ====================
// Carregado sob demanda (só quando a aba "Histórico Pós-Fechamento" é aberta
// pela primeira vez), pra não pesar a busca automática de 5 em 5 minutos.
let HIST_DATA = [];
let HIST_LOADED = false;
let HIST_SELECTED_DOP = null;
let HIST_MODE = "dia"; // "dia" | "semana"
let HIST_SELECTED_PERIOD = null; // chave do dia (YYYY-MM-DD) ou da semana, conforme HIST_MODE

async function loadHistorico(){
  const tableEl = document.getElementById("table-historico");
  if(tableEl) tableEl.innerHTML = '<tbody><tr><td style="padding:14px;color:var(--text-muted)">Carregando histórico…</td></tr></tbody>';
  try{
    const sep = API_URL.indexOf("?") >= 0 ? "&" : "?";
    // Timeout maior que o dos dados principais: a aba "Dados por Dia" tem
    // dezenas de milhares de linhas, então essa busca pode demorar mais.
    const json = await fetchViaIframe(API_URL + sep + "tipo=historico", 45000);
    HIST_DATA = Array.isArray(json) ? json : (json.historico || []);
    HIST_LOADED = true;
    HIST_SELECTED_PERIOD = null;
    populateHistoricoPeriodos();
    renderHistoricoRanking();
  } catch(err){
    console.error(err);
    if(tableEl){
      tableEl.innerHTML = "";
      tableEl.parentElement.innerHTML = '<div class="empty-state">Não foi possível carregar o histórico agora (' + err.message + ').</div>';
    }
  }
}

// Só considera, no histórico, os DOPs que já existem na base do painel
// (agências sob gestão de Hellen/Vitor) — a aba "Dados por Dia" tem
// registros de muitas outras agências fora desse escopo, que só
// poluiriam o ranking (e deixavam a lista enorme).
function historicoFiltradoPorEscopo(){
  return HIST_DATA.filter(h => DATA.some(d=>String(d.dop)===String(h.dop)));
}

// Agrupa o histórico (já filtrado pro escopo) por DOP, cada série
// ordenada por data crescente — pronta pra virar linha do gráfico.
function historicoPorDop(){
  const porDop = {};
  historicoFiltradoPorEscopo().forEach(h=>{
    if(!porDop[h.dop]) porDop[h.dop] = [];
    porDop[h.dop].push(h);
  });
  Object.values(porDop).forEach(arr=> arr.sort((a,b)=> new Date(a.data)-new Date(b.data)));
  return porDop;
}

function fmtDateShort(iso){
  const d = new Date(iso);
  if(isNaN(d)) return iso;
  return d.toLocaleDateString("pt-BR", {day:"2-digit", month:"2-digit"});
}
function dateKey(iso){
  const d = new Date(iso);
  if(isNaN(d)) return iso;
  return d.toISOString().slice(0,10);
}

// Preenche o seletor de período (dias ou semanas disponíveis no histórico
// carregado), mantendo a seleção atual se ela ainda existir na lista.
function populateHistoricoPeriodos(){
  const escopo = historicoFiltradoPorEscopo();
  const sel = document.getElementById("historico-period-select");
  const label = document.getElementById("historico-period-label");
  if(!sel) return;

  if(HIST_MODE === "dia"){
    if(label) label.textContent = "Dia";
    const dias = [...new Set(escopo.map(h=>dateKey(h.data)))].sort().reverse();
    sel.innerHTML = dias.map(k=>`<option value="${k}">${fmtDateShort(k)}</option>`).join("");
    if(!dias.includes(HIST_SELECTED_PERIOD)) HIST_SELECTED_PERIOD = dias[0] || null;
  } else {
    if(label) label.textContent = "Semana";
    const semanas = [...new Set(escopo.map(h=>h.semana).filter(Boolean))].sort().reverse();
    sel.innerHTML = semanas.map(s=>`<option value="${s}">Semana ${s}</option>`).join("");
    if(!semanas.includes(HIST_SELECTED_PERIOD)) HIST_SELECTED_PERIOD = semanas[0] || null;
  }
  sel.value = HIST_SELECTED_PERIOD || "";
}

document.querySelectorAll("#historico-mode-pills .pill").forEach(p=>{
  p.addEventListener("click", ()=>{
    if(p.dataset.mode === HIST_MODE) return;
    document.querySelectorAll("#historico-mode-pills .pill").forEach(x=>x.classList.remove("active"));
    p.classList.add("active");
    HIST_MODE = p.dataset.mode;
    HIST_SELECTED_PERIOD = null;
    if(HIST_LOADED){ populateHistoricoPeriodos(); renderHistoricoRanking(); }
  });
});

const histPeriodSelect = document.getElementById("historico-period-select");
if(histPeriodSelect) histPeriodSelect.addEventListener("change", e=>{
  HIST_SELECTED_PERIOD = e.target.value;
  renderHistoricoRanking();
});

// Ranking Top 10 do período selecionado (um dia específico, ou a soma da
// semana selecionada), com % de impacto = pós-fechamento / inbound total
// da agência naquele período.
function renderHistoricoRanking(){
  const escopo = historicoFiltradoPorEscopo();

  const linhasPeriodo = HIST_MODE === "dia"
    ? escopo.filter(h => dateKey(h.data) === HIST_SELECTED_PERIOD)
    : escopo.filter(h => h.semana === HIST_SELECTED_PERIOD);

  const porDopPeriodo = {};
  linhasPeriodo.forEach(h=>{
    if(!porDopPeriodo[h.dop]) porDopPeriodo[h.dop] = { valor:0, inboundTotal:0 };
    porDopPeriodo[h.dop].valor += num(h.valor);
    porDopPeriodo[h.dop].inboundTotal += num(h.inboundTotal);
  });

  const ranking = Object.keys(porDopPeriodo).map(dop=>{
    const info = DATA.find(d=>String(d.dop)===String(dop));
    const { valor, inboundTotal } = porDopPeriodo[dop];
    return {
      dop,
      agencia: info ? info.agencia : "—",
      resp: info ? info.resp : "—",
      valor,
      pct: inboundTotal > 0 ? (valor/inboundTotal) : 0
    };
  }).sort((a,b)=>b.valor-a.valor).slice(0,10);

  const el = document.getElementById("table-historico");
  if(!el) return;
  if(!ranking.length){
    el.innerHTML = "";
    el.parentElement.innerHTML = '<div class="empty-state">Sem dados de histórico para o período selecionado.</div>';
    return;
  }

  const thead = "<thead><tr><th>DOP</th><th>Agência</th><th>Responsável</th><th>Pós-Fechamento</th><th>% Impacto</th></tr></thead>";
  const tbody = "<tbody>" + ranking.map(l=>`
    <tr onclick="selecionarHistoricoDop(${JSON.stringify(l.dop)})" class="${String(l.dop)===String(HIST_SELECTED_DOP)?'row-selected':''}">
      <td class="dop-strong">${l.dop}</td>
      <td>${l.agencia}</td>
      <td>${l.resp}</td>
      <td>${l.valor.toLocaleString("pt-BR")}</td>
      <td>${pct0(l.pct)}</td>
    </tr>`).join("") + "</tbody>";
  el.innerHTML = thead + tbody;

  const aindaExiste = ranking.some(l=>String(l.dop)===String(HIST_SELECTED_DOP));
  selecionarHistoricoDop(aindaExiste ? HIST_SELECTED_DOP : ranking[0].dop);
}

function selecionarHistoricoDop(dop){
  HIST_SELECTED_DOP = dop;
  const porDop = historicoPorDop();
  const serie = porDop[dop] || [];
  const info = DATA.find(d=>String(d.dop)===String(dop));

  document.querySelectorAll("#table-historico tbody tr").forEach(tr=> tr.classList.remove("row-selected"));
  const rowEl = [...document.querySelectorAll("#table-historico tbody tr")].find(tr=>tr.firstChild && tr.firstChild.textContent===String(dop));
  if(rowEl) rowEl.classList.add("row-selected");

  const card = document.getElementById("historico-chart-card");
  const title = document.getElementById("historico-chart-title");
  if(card) card.style.display = "block";
  if(title) title.textContent = "Evolução diária (últimos 30 dias) — " + (info ? info.agencia : ("DOP " + dop)) + " (DOP " + dop + ")";
  drawLineChart("historico-chart", serie.map(h=>({label: fmtDateShort(h.data), value: num(h.valor)})));
}

// Gráfico de linha simples em SVG puro (sem lib externa), no mesmo estilo
// visual do resto do painel — usa as mesmas variáveis de tema (funciona em
// modo claro e escuro).
function drawLineChart(svgId, points){
  const svg = document.getElementById(svgId);
  if(!svg) return;
  const W = 900, H = 220, padL = 46, padR = 16, padT = 16, padB = 30;
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);

  if(!points.length){
    svg.innerHTML = `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="var(--text-muted)" font-size="12">Sem dados no período.</text>`;
    return;
  }

  const values = points.map(p=>p.value);
  const maxV = Math.max(...values, 1);
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const stepX = points.length>1 ? innerW/(points.length-1) : 0;

  const xAt = i => padL + stepX*i;
  const yAt = v => padT + innerH - (v/maxV)*innerH;

  let grid = "";
  const steps = 4;
  for(let s=0; s<=steps; s++){
    const v = maxV * s/steps;
    const y = yAt(v);
    grid += `<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`;
    grid += `<text x="${padL-8}" y="${y+3}" text-anchor="end" font-size="10" fill="var(--text-muted)">${Math.round(v).toLocaleString("pt-BR")}</text>`;
  }

  let path = "", area = `M ${xAt(0)} ${yAt(0)} `;
  points.forEach((p,i)=>{
    const x = xAt(i), y = yAt(p.value);
    path += (i===0?"M ":"L ") + x + " " + y + " ";
    area += "L " + x + " " + y + " ";
  });
  area += `L ${xAt(points.length-1)} ${yAt(0)} Z`;

  let dots = "", labels = "";
  const labelEvery = Math.max(1, Math.ceil(points.length/8));
  points.forEach((p,i)=>{
    const x = xAt(i), y = yAt(p.value);
    dots += `<circle cx="${x}" cy="${y}" r="3" fill="var(--brand)"/>`;
    if(i===0 || i===points.length-1 || i%labelEvery===0){
      labels += `<text x="${x}" y="${H-8}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${p.label}</text>`;
    }
  });

  svg.innerHTML = grid +
    `<path d="${area}" fill="var(--brand)" opacity="0.10"/>` +
    `<path d="${path}" fill="none" stroke="var(--brand)" stroke-width="2"/>` +
    dots + labels;
}

const histRefreshBtn = document.getElementById("historico-refresh");
if(histRefreshBtn) histRefreshBtn.addEventListener("click", ()=> loadHistorico());

function filtered(){
  return DATA.filter(d =>
    (!filters.resp || d.resp===filters.resp) &&
    (!filters.subreg || d.subreg===filters.subreg) &&
    (!filters.cidade || d.cidade===filters.cidade) &&
    (!filters.statuscoleta || d.statusColeta===filters.statuscoleta) &&
    (!filters.risco || d.risco===filters.risco)
  );
}

function alertIndicador(d){
  if(d.statusColeta && d.statusColeta.toUpperCase().includes("3+")) return {label:"Sem coleta", valor:"3+ dias"};
  if(d.horasSemColeta >= 20) return {label:"Sem coleta", valor: d.horasSemColeta.toFixed(0)+"h"};
  if(d.pctAtrasados >= 15) return {label:"% Atrasados", valor: d.pctAtrasados.toFixed(1)+"%"};
  if(d.backlogEnvelhecido > 0) return {label:"Backlog envelhecido", valor: String(d.backlogEnvelhecido)};
  if(d.backlogOps > 300) return {label:"Backlog Total", valor: d.backlogOps.toLocaleString("pt-BR")};
  return {label:"Score Operacional", valor: d.score.toFixed(0)};
}

// Cards principais — mesmo conjunto do painel de agências (backlog, coleta,
// FIFO/Same Day médios, volumes).
function kpiCardsPrimary(rows){
  const backlogTotal = rows.reduce((s,d)=>s+d.backlogOps,0);
  const semColetaHoje = rows.filter(d=>!d.statusColeta.toUpperCase().includes("COLETOU")).length;
  const fifoMedio = rows.length? rows.reduce((s,d)=>s+d.fifoSemana,0)/rows.length : 0;
  const sdMedio = rows.length? rows.reduce((s,d)=>s+d.sameDaySemana,0)/rows.length : 0;
  const volOutbound = rows.reduce((s,d)=>s+d.outbound,0);
  const volInbound = rows.reduce((s,d)=>s+d.inbound,0);
  return [
    {label:"Backlog Total (OPS)", value: backlogTotal.toLocaleString("pt-BR"), icon:"📦"},
    {label:"Dops Sem Coleta Hoje", value: semColetaHoje, icon:"🚚", cls: semColetaHoje>0?"warn":""},
    {label:"% FIFO Médio (semana)", value: pct0(fifoMedio), icon:"📈"},
    {label:"% Same Day Médio (semana)", value: pct0(sdMedio), icon:"⚡"},
    {label:"Volume Outbound", value: volOutbound.toLocaleString("pt-BR"), icon:"⬆"},
    {label:"Volume Inbound", value: volInbound.toLocaleString("pt-BR"), icon:"⬇"},
  ];
}

// Cards extras — indicadores próprios deste painel operacional (score, risco,
// atrasados), que não existem no painel de agências.
function kpiCardsSecondary(rows){
  const scoreMedio = rows.length? rows.reduce((s,d)=>s+d.score,0)/rows.length : 0;
  const criticos = rows.filter(d=>riskClass(d.risco)==="critical").length;
  const atrasadosMedio = rows.length? rows.reduce((s,d)=>s+d.pctAtrasados,0)/rows.length : 0;
  const perdasQtdTotal = rows.reduce((s,d)=>s+d.perdasQtd,0);
  const perdasValorTotal = rows.reduce((s,d)=>s+d.perdasValor,0);
  return [
    {label:"Score Operacional Médio", value: scoreMedio.toFixed(0), icon:"🎯"},
    {label:"Agências em Risco Crítico", value: criticos, icon:"🔴", cls: criticos>0?"crit":""},
    {label:"% Atrasados Médio", value: atrasadosMedio.toFixed(1)+"%", icon:"⏱"},
    {label:"Pacotes Perdidos (Total)", value: perdasQtdTotal.toLocaleString("pt-BR"), icon:"📉", cls: perdasQtdTotal>0?"warn":""},
    {label:"Valor Perdido (R$)", value: perdasValorTotal.toLocaleString("pt-BR",{style:"currency",currency:"BRL"}), icon:"💸", cls: perdasValorTotal>0?"crit":""},
  ];
}

function renderKpis(targetId, cards){
  const el = document.getElementById(targetId);
  el.innerHTML = "";
  cards.forEach(k=>{
    const div = document.createElement("div");
    div.className = "kpi"+(k.cls?" "+k.cls:"");
    div.innerHTML = `<div class="kpi-label">${k.icon} ${k.label}</div><div class="kpi-value">${k.value}</div>`;
    el.appendChild(div);
  });
}

function renderAlerts(rows){
  const el = document.getElementById("alerts-list");
  const alerts = rows.filter(d=> riskClass(d.risco)==="critical" || d.status.toUpperCase().includes("CRÍT"))
    .sort((a,b)=>a.score-b.score).slice(0,8);
  el.innerHTML = "";
  if(!alerts.length){ el.innerHTML = '<div class="empty-state">Nenhum alerta crítico no momento.</div>'; return; }
  alerts.forEach(d=>{
    const ind = alertIndicador(d);
    const row = document.createElement("div");
    row.className = "alert-row";
    row.style.gridTemplateColumns = "3px 1.3fr 0.55fr 0.95fr 0.7fr 0.55fr";
    row.innerHTML = `<div class="alert-bar" style="background:var(--critical)"></div>
      <div><div class="alert-name">${d.agencia}</div><div class="alert-sub">${d.cidade}</div></div>
      <div>${d.dop}</div>
      <div>${ind.label}</div>
      <div>${ind.valor}</div>
      <div><span class="badge critical"><span class="ic"></span>${d.score.toFixed(0)}</span></div>`;
    row.onclick = ()=> openDetail(d.dop);
    el.appendChild(row);
  });
}

function donut(svgId, legendId, groups, colorFn){
  const svg = document.getElementById(svgId);
  const legend = document.getElementById(legendId);
  const total = groups.reduce((s,g)=>s+g.value,0) || 1;
  const cx=75, cy=75, r=58, rInner=34;
  let angle = -90;
  let paths = "";
  groups.forEach(g=>{
    const frac = g.value/total;
    const sweep = frac*360;
    const a0 = angle, a1 = angle+sweep;
    const large = sweep>180?1:0;
    const p0 = polar(cx,cy,r,a0), p1 = polar(cx,cy,r,a1);
    const p0i = polar(cx,cy,rInner,a0), p1i = polar(cx,cy,rInner,a1);
    paths += `<path d="M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} 1 ${p1.x} ${p1.y} L ${p1i.x} ${p1i.y} A ${rInner} ${rInner} 0 ${large} 0 ${p0i.x} ${p0i.y} Z" fill="${g.color}" stroke="var(--surface-2)" stroke-width="2"/>`;
    angle = a1;
  });
  svg.innerHTML = paths + `<text x="75" y="70" text-anchor="middle" font-size="20" font-weight="700" fill="var(--text-primary)">${total}</text><text x="75" y="86" text-anchor="middle" font-size="10" fill="var(--text-muted)">agências</text>`;
  legend.innerHTML = groups.map(g=>`<div class="legend-item"><span class="legend-swatch" style="background:${g.color}"></span>${g.label}<span class="legend-val">${g.value} (${((g.value/total)*100).toFixed(0)}%)</span></div>`).join("");
}
function polar(cx,cy,r,angleDeg){ const a=(angleDeg*Math.PI)/180; return {x:cx+r*Math.cos(a), y:cy+r*Math.sin(a)}; }

function groupCount(rows, field, mapClassColor){
  const m = {};
  rows.forEach(d=>{ const k=d[field]||"—"; m[k]=(m[k]||0)+1; });
  return Object.entries(m).map(([label,value])=>({label, value, color: mapClassColor(label)}))
    .sort((a,b)=>b.value-a.value);
}

function hbars(targetId, groups, maxColor){
  const el = document.getElementById(targetId);
  const max = Math.max(...groups.map(g=>g.value), 1);
  el.innerHTML = groups.map(g=>`
    <div class="hbar-row">
      <div class="hbar-label">${g.label}</div>
      <div class="hbar-track"><div class="hbar-fill" style="width:${(g.value/max*100).toFixed(1)}%;background:${g.color||maxColor}"></div></div>
      <div class="hbar-val">${typeof g.value === "number" ? g.value.toLocaleString("pt-BR", {maximumFractionDigits:1}) : g.value}</div>
    </div>`).join("");
}

function fifoBadgeClass(v){ return v>=0.95?"good":v>=0.85?"warning":"critical"; }

function renderRankLists(rows){
  const byFifo = [...rows].sort((a,b)=>a.fifoSemana-b.fifoSemana).slice(0,8);
  const fifoHtml = byFifo.map((d,i)=>rankRow(i,d,pct0(d.fifoSemana), fifoBadgeClass(d.fifoSemana))).join("") || emptyRow();
  document.getElementById("rank-fifo").innerHTML = fifoHtml;
  const rankFifoResumo = document.getElementById("rank-fifo-resumo");
  if(rankFifoResumo) rankFifoResumo.innerHTML = byFifo.slice(0,5).map((d,i)=>rankRow(i,d,pct0(d.fifoSemana), fifoBadgeClass(d.fifoSemana))).join("") || emptyRow();

  const bySameDay = [...rows].sort((a,b)=>a.sameDaySemana-b.sameDaySemana).slice(0,8);
  const sdHtml = bySameDay.map((d,i)=>rankRow(i,d,pct0(d.sameDaySemana), fifoBadgeClass(d.sameDaySemana))).join("") || emptyRow();
  document.getElementById("rank-sameday").innerHTML = sdHtml;
  const rankSdResumo = document.getElementById("rank-sameday-resumo");
  if(rankSdResumo) rankSdResumo.innerHTML = bySameDay.slice(0,5).map((d,i)=>rankRow(i,d,pct0(d.sameDaySemana), fifoBadgeClass(d.sameDaySemana))).join("") || emptyRow();

  const byScore = [...rows].sort((a,b)=>a.score-b.score).slice(0,8);
  document.getElementById("rank-score").innerHTML = byScore.map((d,i)=>rankRow(i,d,d.score.toFixed(0), riskClass(d.risco))).join("") || emptyRow();

  const byAtraso = [...rows].sort((a,b)=>b.pctAtrasados-a.pctAtrasados).slice(0,8);
  document.getElementById("rank-atrasados").innerHTML = byAtraso.map((d,i)=>rankRow(i,d,d.pctAtrasados.toFixed(1)+"%", d.pctAtrasados>=15?"critical":d.pctAtrasados>0?"warning":"good")).join("") || emptyRow();

  const byColeta = [...rows].sort((a,b)=>b.horasSemColeta-a.horasSemColeta).slice(0,8);
  document.getElementById("rank-coleta").innerHTML = byColeta.map((d,i)=>rankRow(i,d,d.horasSemColeta.toFixed(0)+"h", coletaClass(d.statusColeta))).join("") || emptyRow();
}

// Tabela "Dops sem coleta há mais tempo" — mesma lógica do painel de agências.
const SEM_COLETA_COLS = [
  {k:"agencia", l:"Agência"}, {k:"dop", l:"DOP"},
  {k:"ultimaColetaFmt", l:"Última Coleta"}, {k:"agingSemColeta", l:"Dias Sem Coleta"},
  {k:"backlogOps", l:"Backlog"}
];
function renderSemColetaTable(rows){
  const withAging = rows.filter(d=>d.agingSemColeta > 0)
    .sort((a,b)=>b.agingSemColeta-a.agingSemColeta)
    .slice(0,8)
    .map(d=> Object.assign({}, d, { ultimaColetaFmt: fmtDate(d.ultimaColeta) }));
  const el = document.getElementById("table-sem-coleta");
  if(!withAging.length){ el.innerHTML = ""; el.parentElement.innerHTML = '<div class="empty-state">Todas as agências coletaram hoje.</div>'; return; }
  const thead = "<thead><tr>"+SEM_COLETA_COLS.map(c=>`<th>${c.l}</th>`).join("")+"</tr></thead>";
  const tbody = "<tbody>"+withAging.map(d=>{
    return "<tr onclick=\"openDetail("+JSON.stringify(d.dop)+")\">"+SEM_COLETA_COLS.map(c=>{
      let v = d[c.k];
      if(c.k==="dop") return `<td class="dop-strong">${v}</td>`;
      if(c.k==="agingSemColeta") return `<td><span class="badge ${v>=3?'critical':v>=2?'warning':'warning'}"><span class="ic"></span>${v} dia(s)</span></td>`;
      if(typeof v==="number") v = v.toLocaleString("pt-BR",{maximumFractionDigits:1});
      return `<td>${v}</td>`;
    }).join("")+"</tr>";
  }).join("")+"</tbody>";
  el.innerHTML = thead+tbody;
}
function emptyRow(){ return '<div class="empty-state">Sem dados para os filtros atuais.</div>'; }
function rankRow(i,d,val,cls){
  return `<div class="alert-row" style="grid-template-columns:18px 1.6fr 0.9fr;cursor:pointer" onclick="openDetail(${JSON.stringify(d.dop)})">
    <div class="rank-num">${i+1}</div>
    <div><div class="alert-name">${d.agencia}</div><div class="alert-sub">DOP ${d.dop} · ${d.cidade}</div></div>
    <div style="text-align:right"><span class="badge ${cls}"><span class="ic"></span>${val}</span></div>
  </div>`;
}

const TABLE_COLS = [
  {k:"dop", l:"DOP"}, {k:"agencia", l:"Agência"}, {k:"cidade", l:"Cidade"}, {k:"resp", l:"Responsável"},
  {k:"backlogOps", l:"Backlog"}, {k:"fifoSemana", l:"% FIFO Semana", fmt:pct0}, {k:"sameDaySemana", l:"% Same Day Semana", fmt:pct0},
  {k:"perdasQtd", l:"Pacotes Perdidos"}, {k:"risco", l:"Risco", badge:riskClass}, {k:"statusColeta", l:"Coleta", badge:coletaClass}, {k:"status", l:"Status", badge:riskClass}
];
let sortState = { key:"backlogOps", dir:-1 };

function renderTable(targetId, rows, cols, sortKeyState){
  const el = document.getElementById(targetId);
  const st = sortKeyState;
  const sorted = [...rows].sort((a,b)=>{
    let va=a[st.key], vb=b[st.key];
    if(typeof va === "string") return va.localeCompare(vb)*st.dir;
    return (va-vb)*st.dir;
  });
  const thead = "<thead><tr>"+cols.map(c=>`<th data-key="${c.k}">${c.l} ${st.key===c.k?(st.dir===1?'<span class="sort-ind">▲</span>':'<span class="sort-ind">▼</span>'):''}</th>`).join("")+"</tr></thead>";
  const tbody = "<tbody>"+sorted.map(d=>{
    return "<tr onclick=\"openDetail("+JSON.stringify(d.dop)+")\">"+cols.map(c=>{
      let v = d[c.k];
      if(c.fmt) v = c.fmt(v);
      if(c.badge){ const cls=c.badge(v); return `<td><span class="badge ${cls}"><span class="ic"></span>${v}</span></td>`; }
      if(c.k==="dop") return `<td class="dop-strong">${v}</td>`;
      if(typeof v==="number") v = v.toLocaleString("pt-BR",{maximumFractionDigits:1});
      return `<td>${v}</td>`;
    }).join("")+"</tr>";
  }).join("")+"</tbody>";
  el.innerHTML = thead+tbody;
  el.querySelectorAll("th").forEach(th=>{
    th.onclick = ()=>{
      const k = th.dataset.key;
      if(st.key===k) st.dir*=-1; else { st.key=k; st.dir=1; }
      renderTable(targetId, rows, cols, st);
    };
  });
}

const BASE_COLS = [
  {k:"dop", l:"DOP"}, {k:"agencia", l:"Agência"}, {k:"resp", l:"Responsável"}, {k:"cidade", l:"Cidade"}, {k:"estado", l:"Estado"},
  {k:"subreg", l:"Sub-Regional"}, {k:"estacao", l:"Estação"}, {k:"backlog", l:"Backlog"}, {k:"backlogOps", l:"Backlog OPS"},
  {k:"inbound", l:"Inbound"}, {k:"outbound", l:"Outbound"}, {k:"fifoSemana", l:"% FIFO Semana", fmt:pct0}, {k:"sameDaySemana", l:"% Same Day Semana", fmt:pct0},
  {k:"pctAtrasados", l:"% Atrasados"}, {k:"horasSemColeta", l:"Hs sem coleta"}, {k:"score", l:"Score"}, {k:"risco", l:"Risco", badge:riskClass},
  {k:"statusColeta", l:"Status Coleta", badge:coletaClass}, {k:"status", l:"Status", badge:riskClass}
];
let baseSortState = { key:"dop", dir:1 };
let gestaoSortState = { key:"backlogOps", dir:-1 };

function fmtDate(iso){
  if(!iso) return "—";
  const d = new Date(iso);
  if(isNaN(d)) return iso;
  return d.toLocaleString("pt-BR", {day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
}

function openDetail(dop){
  const d = DATA.find(x=>String(x.dop)===String(dop));
  document.querySelectorAll(".nav-item").forEach(n=>n.classList.remove("active"));
  document.querySelector('.nav-item[data-section="detalhe"]').classList.add("active");
  document.querySelectorAll(".section").forEach(s=>s.classList.remove("active"));
  document.getElementById("sec-detalhe").classList.add("active");
  document.getElementById("detail-search").value = d ? d.agencia : "";
  renderDetail(d);
}

function renderDetail(d){
  const card = document.getElementById("detail-card");
  if(!d){ card.innerHTML = '<div class="empty-state">Nenhuma agência encontrada.</div>'; return; }
  card.innerHTML = `
    <div class="detail-header">
      <div class="dopid">${d.dop}</div>
      <div>
        <div class="name">${d.agencia}</div>
        <div class="sub">${d.cidade} — ${d.estado} · Responsável: ${d.resp} · Estação ${d.estacao}</div>
      </div>
      <div style="margin-left:auto; display:flex; gap:8px;">
        <span class="badge ${riskClass(d.risco)}"><span class="ic"></span>${d.risco}</span>
        <span class="badge ${riskClass(d.status)}"><span class="ic"></span>${d.status}</span>
      </div>
    </div>
    <div class="detail-grid">
      <div class="detail-item"><div class="l">Backlog Total (OPS)</div><div class="v">${d.backlogOps.toLocaleString("pt-BR")}</div></div>
      <div class="detail-item"><div class="l">% FIFO Semana</div><div class="v">${pct0(d.fifoSemana)}</div></div>
      <div class="detail-item"><div class="l">% Same Day Semana</div><div class="v">${pct0(d.sameDaySemana)}</div></div>
      <div class="detail-item"><div class="l">Cumpriu FIFO Hoje</div><div class="v" style="font-size:13px">${d.fifoHojeFlag>=1 ? "Sim" : "Não"}</div></div>
      <div class="detail-item"><div class="l">Cumpriu Same Day Hoje</div><div class="v" style="font-size:13px">${d.sameDayFlag>=1 ? "Sim" : (d.sameDayFlag>0 ? pct0(d.sameDayFlag)+" (parcial)" : "Não")}</div></div>
      <div class="detail-item"><div class="l">Inbound / Outbound</div><div class="v">${d.inbound.toLocaleString("pt-BR")} / ${d.outbound.toLocaleString("pt-BR")}</div></div>
      <div class="detail-item"><div class="l">% Atrasados</div><div class="v">${d.pctAtrasados.toFixed(1)}%</div></div>
      <div class="detail-item"><div class="l">Backlog Envelhecido</div><div class="v">${d.backlogEnvelhecido}</div></div>
      <div class="detail-item"><div class="l">Pacotes Perdidos</div><div class="v">${d.perdasQtd}</div></div>
      <div class="detail-item"><div class="l">Valor Perdido</div><div class="v">${d.perdasValor.toLocaleString("pt-BR",{style:"currency",currency:"BRL"})}</div></div>
      <div class="detail-item"><div class="l">Status Coleta</div><div class="v" style="font-size:13px">${d.statusColeta}</div></div>
      <div class="detail-item"><div class="l">Horas sem coleta</div><div class="v">${d.horasSemColeta.toFixed(1)}h</div></div>
      <div class="detail-item"><div class="l">Última Coleta</div><div class="v" style="font-size:13px">${fmtDate(d.ultimaColeta)}</div></div>
      <div class="detail-item"><div class="l">Score Operacional</div><div class="v">${d.score.toFixed(0)}</div></div>
      <div class="detail-item"><div class="l">Maturação</div><div class="v" style="font-size:13px">${d.maturacao}</div></div>
      <div class="detail-item"><div class="l">Teve coleta</div><div class="v" style="font-size:13px">${d.tevecoleta}</div></div>
      <div class="detail-item"><div class="l">Atualizado em</div><div class="v" style="font-size:13px">${fmtDate(d.data)}</div></div>
    </div>`;
}

document.getElementById("detail-search").addEventListener("input", e=>{
  const q = e.target.value.trim().toLowerCase();
  if(!q){ document.getElementById("detail-card").innerHTML = '<div class="empty-state">Busque uma agência pelo DOP ou nome para ver o detalhe completo.</div>'; return; }
  const d = DATA.find(x => String(x.dop).toLowerCase()===q || x.agencia.toLowerCase().includes(q) || x.fantasia.toLowerCase().includes(q));
  renderDetail(d);
});

function renderGestaoPills(){
  const el = document.getElementById("gestao-pills");
  const names = uniq("resp");
  el.innerHTML = "";
  names.forEach(n=>{
    const p = document.createElement("div");
    p.className = "pill"+(filters.gestaoResp===n?" active":"");
    p.textContent = n;
    p.onclick = ()=>{ filters.gestaoResp = filters.gestaoResp===n?null:n; renderAll(); };
    el.appendChild(p);
  });
}

function renderAll(){
  const rows = filtered();

  renderKpis("kpi-grid", kpiCardsPrimary(rows));
  renderKpis("kpi-grid-extra", kpiCardsSecondary(rows));
  renderAlerts(rows);
  donut("donut-risco","legend-risco", groupCount(rows,"risco", l=>({good:"#0ca30c",warning:"#fab219",critical:"#d03b3b"}[riskClass(l)])), null);
  donut("donut-coleta","legend-coleta", groupCount(rows,"statusColeta", l=>({good:"#0ca30c",warning:"#fab219",critical:"#d03b3b"}[coletaClass(l)])), null);

  const cidadeCounts = {};
  rows.forEach(d=>{ cidadeCounts[d.cidade]=(cidadeCounts[d.cidade]||0)+1; });
  let cidadeArr = Object.entries(cidadeCounts).map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value);
  let top = cidadeArr.slice(0,7);
  const rest = cidadeArr.slice(7).reduce((s,g)=>s+g.value,0);
  if(rest>0) top.push({label:"Outras", value:rest});
  top.forEach((g,i)=> g.color = CATS[i % CATS.length]);
  donut("donut-cidade","legend-cidade", top, null);

  const subregMap = {};
  rows.forEach(d=>{ (subregMap[d.subreg] = subregMap[d.subreg]||[]).push(d.score); });
  const subregArr = Object.entries(subregMap).map(([label,arr])=>({label, value: arr.reduce((s,v)=>s+v,0)/arr.length, color:"#2a78d6"})).sort((a,b)=>b.value-a.value);
  hbars("bars-subreg", subregArr);

  renderRankLists(rows);
  renderSemColetaTable(rows);
  renderTable("table-desempenho", rows, TABLE_COLS, sortState);
  renderTable("table-base", rows, BASE_COLS, baseSortState);

  // Minha Gestão
  const gestaoRows = filters.gestaoResp ? rows.filter(d=>d.resp===filters.gestaoResp) : rows;
  document.getElementById("nav-gestao-badge").textContent = filters.gestaoResp ? gestaoRows.length : rows.length;
  renderKpis("kpi-grid-gestao", kpiCardsPrimary(gestaoRows).concat(kpiCardsSecondary(gestaoRows)));
  renderTable("table-gestao", gestaoRows, TABLE_COLS, gestaoSortState);
  renderGestaoPills();

  const dates = rows.map(d=>d.data).filter(Boolean).sort();
  const last = dates[dates.length-1];
  document.getElementById("update-chip").title = "Última linha atualizada na planilha: " + (last ? fmtDate(last) : "—");
}

// nav
document.querySelectorAll(".nav-item").forEach(item=>{
  item.addEventListener("click", ()=>{
    document.querySelectorAll(".nav-item").forEach(n=>n.classList.remove("active"));
    item.classList.add("active");
    document.querySelectorAll(".section").forEach(s=>s.classList.remove("active"));
    document.getElementById("sec-"+item.dataset.section).classList.add("active");
    if(item.dataset.section === "historico" && !HIST_LOADED){ loadHistorico(); }
  });
});
document.querySelectorAll("[data-goto]").forEach(el=>{
  el.addEventListener("click", ()=>{
    document.querySelector('.nav-item[data-section="'+el.dataset.goto+'"]').click();
  });
});

// theme
const themeBtn = document.getElementById("theme-toggle");
function applyTheme(t){
  document.documentElement.setAttribute("data-theme", t);
  themeBtn.textContent = t==="dark" ? "☀ Modo claro" : "◑ Modo escuro";
}
let currentTheme = "light";
themeBtn.addEventListener("click", ()=>{ currentTheme = currentTheme==="dark"?"light":"dark"; applyTheme(currentTheme); });
applyTheme(currentTheme);

loadData(true);
setInterval(()=> loadData(false), REFRESH_INTERVAL_MS);
