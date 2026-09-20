/* Equipe Gerador — DMA · app de campo offline
   Cada visita é um registro independente, com geolocalização própria. */
'use strict';

/* ===================== armazenamento (IndexedDB) ===================== */
const BD = (() => {
  let p;
  function abrir(){
    if (p) return p;
    p = new Promise((ok, err) => {
      const r = indexedDB.open('equipe-gerador', 1);
      r.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('visitas')) db.createObjectStore('visitas', {keyPath:'id'});
        if (!db.objectStoreNames.contains('fotos'))   db.createObjectStore('fotos',   {keyPath:'id'});
      };
      r.onsuccess = () => ok(r.result);
      r.onerror   = () => err(r.error);
    });
    return p;
  }
  const tx = async (loja, modo, fn) => {
    const db = await abrir();
    return new Promise((ok, err) => {
      const t = db.transaction(loja, modo), s = t.objectStore(loja);
      let res; const req = fn(s);
      if (req) req.onsuccess = () => { res = req.result; };
      t.oncomplete = () => ok(res);
      t.onerror = () => err(t.error);
    });
  };
  return {
    salvarVisita: v => tx('visitas','readwrite', s => s.put(v)),
    lerVisita:    id => tx('visitas','readonly',  s => s.get(id)),
    listarVisitas:()  => tx('visitas','readonly', s => s.getAll()),
    apagarVisita: id => tx('visitas','readwrite', s => s.delete(id)),
    salvarFoto:  (id,blob) => tx('fotos','readwrite', s => s.put({id, blob})),
    lerFoto:      id => tx('fotos','readonly',  s => s.get(id)),
    apagarFoto:   id => tx('fotos','readwrite', s => s.delete(id)),
  };
})();

/* ===================== versão =====================
   Mostrada na tela inicial para conferir se o aparelho está com a versão publicada.
   A cada publicação: trocar aqui e no CACHE do sw.js. */
const VERSAO_APP = '17';
const DATA_VERSAO = '20/09/2026';

/* ===================== estado ===================== */
let CFG = null;            // checklists.json
let visita = null;         // visita em edição
const urlsFoto = new Map();// id -> objectURL (liberados ao trocar de tela)

const uid = () => (Date.now().toString(36) + Math.random().toString(36).slice(2,8)).toUpperCase();
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function dataBR(iso){
  const d = new Date(iso);
  const p = n => String(n).padStart(2,'0');
  return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()}`;
}
function horaBR(iso){
  const d = new Date(iso), p = n => String(n).padStart(2,'0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* opção "Outro": o técnico digita o nome; a resposta gravada é o texto digitado
   (e não a palavra "Outro"), assim o PDF e o cadastro da loja recebem o nome real */
function temOutro(it){ return it.tipo === 'opcoes' && (it.opcoes || []).includes('Outro'); }
function ehOutro(it, r){
  return temOutro(it) && r != null && r !== '' && !it.opcoes.filter(o => o !== 'Outro').includes(r);
}
function respostaVazia(it, r){ return r == null || r === '' || (r === 'Outro' && temOutro(it)); }

/* rede da visita: nas lojas do Supermercados BH a foto continua obrigatória em toda
   pergunta de opções; nas lojas da DMA (EPA/Mineirão) a resposta escolhida entre as
   opções dispensa foto (só exige quando marca "Outro") */
function redeDaVisita(v){
  v = v || visita;
  if (!v || !v.loja) return null;
  const l = encontrarLoja(v.loja.cod);
  return (l && l.rede) || v.loja.rede || null;
}
function opcoesDispensamFoto(rede){ return rede != null && rede !== 'Supermercados BH'; }

/* ===================== regra de conformidade =====================
   Mesma regra conferida contra os 33 relatórios em PDF:
   perguntas numeradas de Sim/Não são conformidade; em "Existe vestígio..."
   e "possui vazamentos...", o "Sim" é que é a não conformidade. */
function situacao(item, resp){
  if (resp == null || resp === '') return 'Pendente';
  const r = String(resp).trim().toLowerCase();
  if (r.startsWith('não se aplica') || r.startsWith('nao se aplica')) return 'Não se aplica';
  const p = item.pergunta.toLowerCase();
  const numerada = /^\d+\.\s/.test(item.pergunta);
  const ehSimNao = (r === 'sim' || r === 'não' || r === 'nao');
  if (!ehSimNao) return 'Informativo';
  const criticavel = numerada || item.prioridade;   // itens da preventiva não são numerados mas têm prioridade
  if (!criticavel) return 'Informativo';
  if (p.includes('nível de combustível') || p.includes('corrente fase')) return 'Informativo';
  const negativa = p.includes('existe vestígio') || p.includes('possui vazamentos');
  const sim = (r === 'sim');
  if (negativa) return sim ? 'Não conforme' : 'Conforme';
  return sim ? 'Conforme' : 'Não conforme';
}

/* ===================== visibilidade condicional ===================== */
const visivel = (item, respostas) => {
  if (!item.cond) return true;
  const v = respostas[item.cond.id];
  return v != null && String(v).trim().toLowerCase() === String(item.cond.igual).trim().toLowerCase();
};

/* precisa de foto? */
function exigeFoto(item, resp){
  if (item._bloqueado) return false; // dado técnico já cadastrado da loja: não pede foto de novo
  if (!item.foto) return false;
  // pergunta de opções: resposta escolhida entre as opções dispensa foto;
  // só exige foto quando o técnico marcou "Outro" e digitou um nome
  if (item.foto.sempre && (item.tipo === 'opcoes' || item.tipo === 'tristate') && opcoesDispensamFoto(redeDaVisita())) return ehOutro(item, resp);
  if (item.foto.sempre) return true;
  if (item.foto.quando) return resp != null &&
    String(resp).trim().toLowerCase() === String(item.foto.quando).trim().toLowerCase();
  return false;
}

/* ===================== dados técnicos por loja (cadastro único) =====================
   Os campos da seção "Dados técnicos" (fabricante, potência, tensão etc.) são
   características do equipamento da loja, não da visita. São perguntados normalmente
   na primeira vez (loja nova ou com cadastro incompleto); depois disso ficam
   registrados na loja e o app só mostra o valor, sem perguntar de novo. */
function camposTecnicosDoBloco(bloco){
  return (CFG.dadosTecnicosPorBloco && CFG.dadosTecnicosPorBloco[bloco]) || [];
}
function encontrarLoja(cod){
  return (CFG.lojas || []).find(l => l.cod.toUpperCase() === String(cod || '').trim().toUpperCase());
}
function dadosTecnicosCompletos(loja, bloco){
  const campos = camposTecnicosDoBloco(bloco);
  if (!campos.length) return true;
  const dt = loja && loja.dadosTecnicos && loja.dadosTecnicos[bloco];
  if (!dt) return false;
  return campos.every(c => dt[c.id] != null && String(dt[c.id]).trim() !== '');
}
/* itens efetivos do checklist: dados técnicos do bloco (bloqueados ou não) + itens normais */
function itensDoChecklist(chk, v){
  const campos = camposTecnicosDoBloco(chk.bloco);
  if (!campos.length) return chk.itens;
  const bloqueado = !!(v && v._dtBloqueado);
  const prefixo = campos.map(c => Object.assign({}, c, {_bloqueado: bloqueado}));
  return [...prefixo, ...chk.itens];
}

/* ===================== base central (planilha Google via Apps Script) =====================
   O cadastro técnico e as lojas novas cadastradas em campo são compartilhados entre
   todos os aparelhos por uma planilha Google ("Equipe Gerador - Cadastro de Lojas",
   conta chwcds). Ordem de precedência ao montar a loja em memória:
     checklists.json  <  cópia local da base central  <  envios ainda pendentes deste aparelho.
   Tudo funciona offline: o que o técnico preenche entra numa fila e é enviado quando
   houver internet; a última cópia baixada da base central fica guardada no aparelho. */
const BASE_CENTRAL_URL = 'https://script.google.com/macros/s/AKfycbyMbRFI4qbTCtICWeC4xZdtVly9SIvNnlmoZ5pcbMpKSbuQdhAgQP0WldnXxFry89g2/exec';
const lerLS = (k, padrao) => { try { return JSON.parse(localStorage.getItem(k)) ?? padrao; } catch (e) { return padrao; } };
const gravarLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const central = { cache: null, ultimaSync: null, enviando: false, erro: null };

function aplicarDadosTecnicos(chave, dados){
  const [cod, bloco] = chave.split('|');
  const l = encontrarLoja(cod);
  if (!l || !dados) return;
  l.dadosTecnicos = l.dadosTecnicos || {};
  l.dadosTecnicos[bloco] = Object.assign({}, l.dadosTecnicos[bloco] || {}, dados);
}
/* recompõe CFG.lojas a partir do checklists.json puro + base central + fila pendente.
   A lista de lojas é só a do banco de dados: o técnico não cadastra loja em campo
   (inclusão de loja nova é feita pelo back-end, no checklists.json). */
function aplicarExtrasLocais(){
  if (CFG._lojasBase) CFG.lojas = JSON.parse(CFG._lojasBase);
  else CFG._lojasBase = JSON.stringify(CFG.lojas);
  migrarExtrasAntigos();
  central.cache = lerLS('baseCentralCache', null);
  if (central.cache){
    for (const chave in (central.cache.dadosTecnicos || {})) aplicarDadosTecnicos(chave, central.cache.dadosTecnicos[chave]);
    central.ultimaSync = central.cache.baixadoEm || null;
  }
  for (const it of lerLS('filaCentral', [])){
    if (it.tipo === 'dadosTecnicos') aplicarDadosTecnicos(`${it.cod}|${it.bloco}`, it.dados);
  }
}
/* versões anteriores guardavam o cadastro técnico só neste aparelho (dadosTecnicosExtras):
   na primeira abertura da versão nova, esse acervo entra na fila para ir à base central */
function migrarExtrasAntigos(){
  if (localStorage.getItem('extrasMigrados')) return;
  const fila = lerLS('filaCentral', []).filter(it => it.tipo === 'dadosTecnicos');
  const overrides = lerLS('dadosTecnicosExtras', {});
  for (const chave in overrides){
    const [cod, bloco] = chave.split('|');
    fila.push({tipo:'dadosTecnicos', cod, bloco, dados: overrides[chave], tecnico:'', criadoEm:new Date().toISOString()});
  }
  gravarLS('filaCentral', fila);
  localStorage.setItem('extrasMigrados', '1');
}
/* entra na fila (substituindo item igual) e tenta enviar */
function enfileirarCentral(item){
  const fila = lerLS('filaCentral', []);
  const chave = it => `${it.tipo}|${it.cod}|${it.bloco || ''}`;
  const i = fila.findIndex(it => chave(it) === chave(item));
  if (i >= 0) fila[i] = item; else fila.push(item);
  gravarLS('filaCentral', fila);
  atualizarStatusCentral();
  clearTimeout(enfileirarCentral._t);
  enfileirarCentral._t = setTimeout(enviarFilaCentral, 1500);
}
async function enviarFilaCentral(){
  const fila = lerLS('filaCentral', []);
  if (!fila.length || central.enviando || !navigator.onLine) return;
  central.enviando = true; central.erro = null; atualizarStatusCentral();
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
    const r = await fetch(BASE_CENTRAL_URL, {method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'},
      body: JSON.stringify({lote: fila}), signal: ctl.signal});
    clearTimeout(t);
    const j = await r.json();
    if (!j.ok) throw new Error(j.erro || 'resposta inválida');
    // enviados: saem da fila e passam a valer pela cópia local da base central
    const restante = lerLS('filaCentral', []).filter(it => !fila.some(f => f.tipo === it.tipo && f.cod === it.cod && (f.bloco||'') === (it.bloco||'') && f.criadoEm === it.criadoEm));
    gravarLS('filaCentral', restante);
    const cache = central.cache || {dadosTecnicos:{}};
    for (const it of fila){
      if (it.tipo !== 'dadosTecnicos') continue;
      const k = `${it.cod}|${it.bloco}`;
      cache.dadosTecnicos[k] = Object.assign({}, cache.dadosTecnicos[k] || {}, it.dados);
    }
    central.cache = cache; gravarLS('baseCentralCache', cache);
    localStorage.removeItem('lojasExtras'); localStorage.removeItem('dadosTecnicosExtras');
  } catch (e) {
    central.erro = 'sem conexão com a base central';
  } finally {
    central.enviando = false; atualizarStatusCentral();
  }
}
/* baixa a base central inteira (ao abrir o app e ao voltar a rede) */
async function baixarBaseCentral(){
  if (!navigator.onLine) return false;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
    const r = await fetch(BASE_CENTRAL_URL + '?t=' + Date.now(), {cache:'no-store', signal: ctl.signal});
    clearTimeout(t);
    const j = await r.json();
    if (!j.ok) throw new Error(j.erro || 'resposta inválida');
    central.cache = {dadosTecnicos: j.dadosTecnicos || {}, baixadoEm: new Date().toISOString()};
    gravarLS('baseCentralCache', central.cache);
    central.erro = null;
    aplicarExtrasLocais();
    return true;
  } catch (e) {
    central.erro = 'sem conexão com a base central';
    return false;
  } finally {
    atualizarStatusCentral();
  }
}
async function sincronizarCentral(){
  await enviarFilaCentral();
  await baixarBaseCentral();   // o cadastro baixado já vale para a próxima loja escolhida na tela inicial
}
function textoStatusCentral(){
  const pend = lerLS('filaCentral', []).length;
  if (central.enviando) return 'Enviando cadastro para a base central…';
  const partes = [];
  if (central.ultimaSync) partes.push(`Base de lojas atualizada em ${dataBR(central.ultimaSync)} ${horaBR(central.ultimaSync).slice(0,5)}`);
  else partes.push('Base de lojas ainda não baixada');
  if (pend) partes.push(`${pend} cadastro${pend>1?'s':''} aguardando envio`);
  if (central.erro) partes.push(central.erro);
  return partes.join(' · ');
}
function atualizarStatusCentral(){
  const el = document.getElementById('statusCentral');
  if (el) el.textContent = textoStatusCentral();
}

/* quando todos os campos técnicos do bloco foram respondidos nesta visita, grava no
   cadastro da loja e manda para a base central, para os outros aparelhos não perguntarem de novo */
function salvarDadosTecnicosSeCompleto(chk, v){
  const campos = camposTecnicosDoBloco(chk.bloco);
  if (!campos.length || v._dtBloqueado) return;
  if (!campos.every(c => !respostaVazia(c, v.respostas[c.id]) && String(v.respostas[c.id]).trim() !== '')) return;
  const l = encontrarLoja(v.loja.cod);
  if (!l) return;
  const valores = {};
  campos.forEach(c => { valores[c.id] = v.respostas[c.id]; });
  const atual = (l.dadosTecnicos && l.dadosTecnicos[chk.bloco]) || {};
  if (campos.every(c => atual[c.id] === valores[c.id])) return; // nada mudou
  aplicarDadosTecnicos(`${v.loja.cod}|${chk.bloco}`, valores);
  enfileirarCentral({tipo:'dadosTecnicos', cod:v.loja.cod, bloco:chk.bloco, dados:valores, tecnico:v.tecnico||'', criadoEm:new Date().toISOString()});
}

/* item pendente = visível, sem resposta, ou com foto exigida faltando */
function pendencias(chk, v){
  const faltando = [];
  for (const it of itensDoChecklist(chk, v)){
    if (!visivel(it, v.respostas)) continue;
    const r = v.respostas[it.id];
    const semResposta = (it.tipo === 'foto') ? false : respostaVazia(it, r);
    const fotos = (v.fotos[it.id] || []);
    const semFoto = (it.tipo === 'foto' ? true : exigeFoto(it, r)) && fotos.length === 0;
    if (semResposta || semFoto) faltando.push({item: it, semResposta, semFoto});
  }
  return faltando;
}

/* ===================== geolocalização ===================== */
function pegarLocal(){
  return new Promise(ok => {
    if (!navigator.geolocation) return ok({erro:'Aparelho sem GPS disponível'});
    navigator.geolocation.getCurrentPosition(
      pos => ok({lat: +pos.coords.latitude.toFixed(6), lon: +pos.coords.longitude.toFixed(6),
                 precisao: Math.round(pos.coords.accuracy), em: new Date().toISOString()}),
      e   => ok({erro: e.code === 1 ? 'Permissão de localização negada'
                      : e.code === 3 ? 'Tempo esgotado ao obter o GPS'
                      : 'Não foi possível obter a localização'}),
      {enableHighAccuracy:true, timeout:15000, maximumAge:0});
  });
}
const localTexto = g => !g ? '—'
  : g.erro ? g.erro
  : `Lat: ${g.lat}, Long: ${g.lon} (Precisão: ${g.precisao}m)`;

/* ===================== fotos ===================== */
async function comprimir(file){
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const MAX = 1600;
  const escala = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * escala), h = Math.round(bmp.height * escala);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
  return await new Promise(ok => c.toBlob(b => ok(b || file), 'image/jpeg', 0.72));
}
async function urlFoto(id){
  if (urlsFoto.has(id)) return urlsFoto.get(id);
  const reg = await BD.lerFoto(id);
  if (!reg) return '';
  const u = URL.createObjectURL(reg.blob);
  urlsFoto.set(id, u);
  return u;
}
function liberarUrls(){
  for (const u of urlsFoto.values()) URL.revokeObjectURL(u);
  urlsFoto.clear();
}

/* ===================== navegação ===================== */
const $tela = document.getElementById('tela');
const $titulo = document.getElementById('tituloTela');
const $voltar = document.getElementById('btnVoltar');
const $barra = document.getElementById('barra');
const $barraInt = document.getElementById('barraInterno');
let voltarPara = null;

function montarTela({titulo, sub, voltar, html, barra}){
  $titulo.innerHTML = `<span>${esc(titulo)}</span>` + (sub ? `<small>${esc(sub)}</small>` : '');
  voltarPara = voltar || null;
  $voltar.classList.toggle('oculto', !voltar);
  $tela.innerHTML = html;
  if (barra){ $barraInt.innerHTML = barra; $barra.classList.remove('oculto'); }
  else $barra.classList.add('oculto');
  window.scrollTo(0,0);
}
$voltar.onclick = () => { if (voltarPara) voltarPara(); };

/* ===================== telas: em andamento / relatórios =====================
   O que o técnico responde é salvo a cada toque; se o app fechar no meio (ligação,
   bateria), a visita fica em "Em andamento" para continuar de onde parou.
   Visitas finalizadas ficam em "Relatórios" (abrir, gerar PDF, compartilhar). */
function linhaVisita(v){
  const chk = CFG.checklists.find(c => c.id === v.checklist);
  const nc = v.finalizada ? contarNC(chk, v) : 0;
  const excluir = !v.finalizada
    ? `<button type="button" class="btn-excluir" data-excluir="${esc(v.id)}" aria-label="Excluir" title="Excluir">🗑</button>`
    : '';
  return `<div class="linha-lista" data-abrir="${v.id}">
    <div class="cresce">
      <div class="t">${esc(v.loja.cod)} — ${esc(v.loja.nome || 'sem nome')}</div>
      <div class="s">${esc(chk ? chk.titulo : v.checklist)} · ${dataBR(v.criadoEm)} ${horaBR(v.criadoEm).slice(0,5)} · ${esc((v.tecnico || '').split(' ')[0])}${
        nc ? ` · <strong style="color:var(--vermelho)">${nc} não conforme${nc>1?'s':''}</strong>` : ''}</div>
    </div>
    <span class="pilula ${v.finalizada ? 'pronta' : 'rascunho'}">${v.finalizada ? 'finalizada' : 'em andamento'}</span>
    ${excluir}
  </div>`;
}
function ligarListaVisitas(recarregar){
  $tela.querySelectorAll('[data-abrir]').forEach(el => {
    el.onclick = async () => {
      visita = await BD.lerVisita(el.dataset.abrir);
      visita.finalizada ? telaRelatorio() : telaChecklist();
    };
  });
  $tela.querySelectorAll('[data-excluir]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const id = btn.dataset.excluir;
      if (!confirm('Excluir esta visita em andamento? As respostas e fotos dela serão apagadas e isso não pode ser desfeito.')) return;
      await apagarVisitaCompleta(id);
      recarregar();
    };
  });
}
/* apaga a visita e todas as fotos dela do banco do aparelho */
async function apagarVisitaCompleta(id){
  const v = await BD.lerVisita(id);
  if (v){
    const idsFoto = Object.values(v.fotos || {}).flat();
    for (const fid of idsFoto) await BD.apagarFoto(fid);
  }
  await BD.apagarVisita(id);
}
async function telaEmAndamento(){
  visita = null;
  liberarUrls();
  const vs = (await BD.listarVisitas()).filter(v => !v.finalizada).sort((a,b) => b.criadoEm.localeCompare(a.criadoEm));
  montarTela({
    titulo: 'Em andamento', sub: `${vs.length} visita${vs.length === 1 ? '' : 's'} para continuar`, voltar: telaInicio,
    html: vs.length
      ? `<div class="aviso">Toque na visita para continuar de onde parou. Tudo que foi respondido está guardado.</div>${vs.map(linhaVisita).join('')}`
      : `<div class="vazio"><div class="ico">✅</div>Nenhuma visita em andamento.</div>`
  });
  ligarListaVisitas(telaEmAndamento);
}
async function telaRelatorios(){
  visita = null;
  liberarUrls();
  const vs = (await BD.listarVisitas()).filter(v => v.finalizada).sort((a,b) => b.criadoEm.localeCompare(a.criadoEm));
  montarTela({
    titulo: 'Relatórios', sub: `${vs.length} relatório${vs.length === 1 ? '' : 's'} gerado${vs.length === 1 ? '' : 's'} neste aparelho`, voltar: telaInicio,
    html: vs.length
      ? vs.map(linhaVisita).join('')
      : `<div class="vazio"><div class="ico">📄</div>Nenhum relatório gerado ainda.</div>`
  });
  ligarListaVisitas(telaRelatorios);
}

function contarNC(chk, v){
  if (!chk) return 0;
  return chk.itens.filter(it => visivel(it, v.respostas) &&
    situacao(it, v.respostas[it.id]) === 'Não conforme').length;
}

/* ===================== tela: início (técnico, rede, loja, checklist) ===================== */
async function telaInicio(){
  visita = null;
  liberarUrls();
  const ultimoTec = localStorage.getItem('ultimoTecnico') || '';
  const ultimaRede = localStorage.getItem('ultimaRede') || 'Supermercados BH';
  const redes = ['Supermercados BH', 'DMA'];
  const todas = await BD.listarVisitas();
  const nAndamento = todas.filter(v => !v.finalizada).length, nRelatorios = todas.filter(v => v.finalizada).length;

  montarTela({
    titulo: 'Equipe Gerador', sub: `Grupo DMA · versão ${VERSAO_APP}`,
    html: `
    <div class="atalhos">
      <button type="button" class="btn sec" id="bAndamento">Em andamento${nAndamento ? ` <b>${nAndamento}</b>` : ''}</button>
      <button type="button" class="btn sec" id="bRelatorios">Relatórios${nRelatorios ? ` <b>${nRelatorios}</b>` : ''}</button>
    </div>
    <div class="cartao">
      <label class="campo"><span>Técnico responsável</span>
        <select id="fTec">
          <option value="">Selecione…</option>
          ${(CFG.tecnicos || []).map(t =>
            `<option value="${esc(t)}" ${t === ultimoTec ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        </select>
      </label>

      <div class="campo" style="margin-bottom:14px"><span style="display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:5px">Rede que está atendendo</span>
        <div class="opcoes" id="fRede">
          ${redes.map(r =>
            `<button type="button" data-rede="${esc(r)}" aria-pressed="${r === ultimaRede ? 'true' : 'false'}">${esc(r)}</button>`).join('')}
        </div>
      </div>

      <label class="campo"><span>Loja</span>
        <input type="text" id="fBuscaLoja" placeholder="Digite o código ou o nome da loja para buscar"
          autocomplete="off" autocapitalize="characters" style="margin-bottom:8px">
        <select id="fLoja">
          <option value="">Selecione…</option>
        </select>
      </label>
      <div id="lojaInfo" class="s" style="font-size:12.5px;color:var(--cinza);margin:-8px 0 10px"></div>

      <label class="campo" style="margin-top:14px"><span>Matrícula do gerente que acompanhou</span>
        <input type="number" id="fMat" inputmode="numeric" placeholder="Ex.: 653335"></label>
    </div>

    <div class="cartao">
      <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:6px">Localização da visita (obrigatória)</div>
      <div id="geo" style="font-size:13px;color:var(--cinza)">Obtendo GPS…</div>
      <button class="btn sec pq oculto" id="bGeo" style="margin-top:9px">Tentar novamente</button>
    </div>

    <h2>Qual checklist?</h2>
    <div id="listaChecklists">
    ${CFG.checklists.map(c => `
      <div class="linha-lista desabilitada" data-chk="${c.id}">
        <div class="cresce"><div class="t">${esc(c.titulo)}</div>
        <div class="s" data-resumo="${c.id}"></div></div>
        <span style="color:var(--cinza);font-size:20px">›</span>
      </div>`).join('')}
    </div>
    <div id="erroNova"></div>
    <div class="status-central"><div id="statusCentral">${esc(textoStatusCentral())}</div>
      <div class="versao">Equipe Gerador — versão ${esc(VERSAO_APP)} (${esc(DATA_VERSAO)}) · base de lojas ${esc(CFG.versao || '')}</div></div>`
  });
  document.getElementById('bAndamento').onclick = telaEmAndamento;
  document.getElementById('bRelatorios').onclick = telaRelatorios;

  const $tec = document.getElementById('fTec');
  const $redeBox = document.getElementById('fRede');
  // botões (não lista suspensa): $rede.value devolve a rede marcada
  const $rede = { get value(){ return $redeBox.querySelector('button[aria-pressed="true"]')?.dataset.rede || ''; } };
  const $loja = document.getElementById('fLoja'), $info = document.getElementById('lojaInfo');
  const $lista = document.getElementById('listaChecklists');
  let geo = null, geoOk = false;

  const atualizarResumos = () => {
    const dispensa = opcoesDispensamFoto($rede.value);
    CFG.checklists.forEach(c => {
      const el = $lista.querySelector(`[data-resumo="${CSS.escape(c.id)}"]`);
      if (!el) return;
      const comFoto = c.itens.filter(i => i.foto && (i.foto.quando || !dispensa || !(i.tipo === 'opcoes' || i.tipo === 'tristate') || temOutro(i))).length;
      el.textContent = `${c.itens.length} itens · ${comFoto} com foto`;
    });
  };
  const $busca = document.getElementById('fBuscaLoja');
  const normalizar = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
  const numCod = c => { const n = parseInt(String(c).replace(/\D/g, ''), 10); return isNaN(n) ? Infinity : n; };
  // lista em ordem de código (D002, D003, ... / L001, L002, ...); a busca filtra por código ou nome
  const montarListaLojas = (manterSelecao) => {
    const redeSelecionada = $rede.value;
    const termo = normalizar($busca.value);
    const anterior = manterSelecao ? $loja.value : '';
    let lista = (CFG.lojas || []).filter(l => !redeSelecionada || l.rede === redeSelecionada);
    if (termo) lista = lista.filter(l => normalizar(l.cod).includes(termo) || normalizar(l.nome).includes(termo));
    lista.sort((a, b) => (numCod(a.cod) - numCod(b.cod)) || String(a.cod).localeCompare(String(b.cod)));
    $loja.innerHTML = `<option value="">${lista.length ? 'Selecione…' : 'Nenhuma loja encontrada'}</option>`;
    lista.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.cod;
      opt.textContent = `${l.cod} — ${l.nome}`;
      $loja.appendChild(opt);
    });
    if (anterior && lista.some(l => l.cod === anterior)) $loja.value = anterior;
    else if (termo && lista.length === 1) $loja.value = lista[0].cod;   // só uma loja bate: já seleciona
    else $loja.value = '';
    $info.textContent = '';
    const l = encontrarLoja($loja.value);
    if (l) $info.textContent = l.endereco || 'Endereço não cadastrado.';
  };
  const atualizarLojasComFiltro = () => {
    atualizarResumos();
    $busca.value = '';
    montarListaLojas(false);
  };
  $busca.oninput = () => montarListaLojas(true);

  $redeBox.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      $redeBox.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      localStorage.setItem('ultimaRede', b.dataset.rede);
      atualizarLojasComFiltro();
    };
  });
  atualizarLojasComFiltro(); // já abre filtrada pela última rede usada

  const bloquearChecklists = () => {
    $lista.querySelectorAll('[data-chk]').forEach(el => el.classList.toggle('desabilitada', !geoOk));
  };

  const $geo = document.getElementById('geo'), $bGeo = document.getElementById('bGeo');
  const buscarGeo = async () => {
    $bGeo.classList.add('oculto');
    $geo.textContent = 'Obtendo GPS…'; $geo.style.color = 'var(--cinza)';
    geo = await pegarLocal();
    geoOk = !geo.erro;
    $geo.textContent = geoOk ? localTexto(geo)
      : `${geo.erro} — a localização é obrigatória para iniciar a visita.`;
    $geo.style.color = geoOk ? 'var(--verde)' : 'var(--vermelho)';
    $bGeo.classList.toggle('oculto', geoOk);
    bloquearChecklists();
  };
  buscarGeo();
  $bGeo.onclick = buscarGeo;

  const preencherInfoLoja = () => {
    const l = encontrarLoja($loja.value);
    $info.textContent = l ? (l.endereco || 'Endereço não cadastrado.') : '';
  };
  $loja.onchange = preencherInfoLoja;

  $lista.querySelectorAll('[data-chk]').forEach(el => {
    el.onclick = async () => {
      const $err = document.getElementById('erroNova');
      if (!geoOk){
        $err.innerHTML = `<div class="aviso erro">Aguarde a localização ser obtida — ela é obrigatória para iniciar a visita.</div>`;
        $err.scrollIntoView({behavior:'smooth', block:'center'});
        return;
      }
      const tec = $tec.value, rede = $rede.value, codLoja = $loja.value;
      if (!tec || !rede || !codLoja){
        $err.innerHTML = `<div class="aviso erro">Selecione o técnico, a rede e a loja antes de escolher o checklist.</div>`;
        $err.scrollIntoView({behavior:'smooth', block:'center'});
        return;
      }
      localStorage.setItem('ultimoTecnico', tec);
      const loja = encontrarLoja(codLoja);
      const chk = CFG.checklists.find(c => c.id === el.dataset.chk);
      const bloqueado = dadosTecnicosCompletos(loja, chk.bloco);
      const respostas = {};
      const campos = camposTecnicosDoBloco(chk.bloco);
      if (campos.length){
        const dt = (loja.dadosTecnicos && loja.dadosTecnicos[chk.bloco]) || {};
        campos.forEach(c => { if (dt[c.id] != null && dt[c.id] !== '') respostas[c.id] = dt[c.id]; });
      }
      visita = {
        id: uid(), criadoEm: new Date().toISOString(), finalizada: false,
        tecnico: tec,
        loja: {cod: loja.cod, nome: loja.nome, endereco: loja.endereco || '', rede: loja.rede || rede},
        matricula: document.getElementById('fMat').value.trim(),
        geo, checklist: el.dataset.chk, respostas, obs: {}, fotos: {},
        _dtBloqueado: bloqueado
      };
      await BD.salvarVisita(visita);
      telaChecklist();
    };
  });
}

/* ===================== tela: checklist ===================== */
const CLASSE_PRIO = {'Crítica':'critica','Alta':'alta','Média':'media','Media':'media'};
const RUINS = ['não','nao'];

function telaChecklist(){
  liberarUrls();
  const chk = CFG.checklists.find(c => c.id === visita.checklist);
  const itens = itensDoChecklist(chk, visita);
  const campos = camposTecnicosDoBloco(chk.bloco);
  let html = '';
  let secaoAtual = null;
  itens.forEach((it, idx) => {
    if (it.secao !== secaoAtual){ secaoAtual = it.secao; html += `<h2>${esc(secaoAtual)}</h2>`; }
    html += htmlItem(it);
    if (campos.length && idx === campos.length - 1 && visita._dtBloqueado){
      html += `<button type="button" class="link-acao" id="bCorrigirDT">Dados técnicos incorretos? Corrigir cadastro da loja</button>`;
    }
  });
  montarTela({
    titulo: chk.titulo,
    sub: `${visita.loja.cod} — ${visita.loja.nome || 's/ nome'} · ${visita.tecnico.split(' ')[0]}`,
    voltar: async () => { await BD.salvarVisita(visita); telaInicio(); },   // sair guarda a visita em "Em andamento"
    html: `<div class="progresso"><i id="pbar"></i></div><div class="prog-txt" id="ptxt"></div>${html}`,
    barra: `<button class="btn perigo" id="bCancelar" style="flex:1">Cancelar relatório</button>
            <button class="btn" id="bRevisar" style="flex:1.4">Revisar e finalizar</button>`
  });
  ligarItens(chk, itens);
  atualizarProgresso(chk);
  document.getElementById('bRevisar').onclick = async () => { await BD.salvarVisita(visita); telaRevisao(); };
  // desistir do relatório: apaga a visita e as fotos dela deste aparelho (não vai para "Em andamento")
  document.getElementById('bCancelar').onclick = async () => {
    if (!confirm('Cancelar este relatório? Tudo que foi respondido e fotografado nesta visita será apagado. Isso não pode ser desfeito.')) return;
    await apagarVisitaCompleta(visita.id);
    visita = null;
    telaInicio();
  };
  const bCorr = document.getElementById('bCorrigirDT');
  if (bCorr) bCorr.onclick = async () => { visita._dtBloqueado = false; await BD.salvarVisita(visita); telaChecklist(); };
}

function htmlItem(it){
  const r = visita.respostas[it.id];
  if (it._bloqueado){
    return `<div class="item bloqueado respondido" data-item="${esc(it.id)}">
      <div class="enunciado">${esc(it.pergunta)}</div>
      <div class="valor-fixo">${esc(r == null || r === '' ? '—' : r)}</div>
    </div>`;
  }
  const prio = it.prioridade ? `<span class="tag ${CLASSE_PRIO[it.prioridade]||'media'}">${esc(it.prioridade)}</span>` : '';
  let rotuloFoto = '';
  if (it.foto && it.foto.quando) rotuloFoto = `foto se ${it.foto.quando}`;
  else if (it.foto && it.foto.sempre && (it.tipo === 'opcoes' || it.tipo === 'tristate') && opcoesDispensamFoto(redeDaVisita())) rotuloFoto = temOutro(it) ? 'foto se Outro' : '';
  else if (it.foto) rotuloFoto = 'foto';
  const tagFoto = rotuloFoto ? `<span class="tag foto">${esc(rotuloFoto)}</span>` : '';
  let entrada = '';
  if (it.tipo === 'opcoes' || it.tipo === 'tristate'){
    entrada = `<div class="opcoes">${it.opcoes.map(o => {
      const cls = RUINS.includes(o.toLowerCase()) ? 'ruim'
                : o.toLowerCase().startsWith('não se aplica') ? 'na' : '';
      const marcado = (r === o) || (o === 'Outro' && ehOutro(it, r));
      return `<button type="button" class="${cls}" data-op="${esc(it.id)}" data-val="${esc(o)}"
        aria-pressed="${marcado}">${esc(o)}</button>`;
    }).join('')}</div>`;
    if (temOutro(it)){
      entrada += `<input type="text" data-outro="${esc(it.id)}" class="${ehOutro(it, r) ? '' : 'oculto'}"
        style="margin-top:9px" placeholder="Qual? Digite o nome" value="${esc(r === 'Outro' ? '' : (ehOutro(it, r) ? r : ''))}">`;
    }
  } else if (it.tipo === 'numero'){
    entrada = `<input type="text" inputmode="decimal" data-in="${esc(it.id)}"
       value="${esc(r || '')}" placeholder="Digite o valor">`;
  } else if (it.tipo === 'texto'){
    entrada = `<input type="text" data-in="${esc(it.id)}" value="${esc(r || '')}" placeholder="Digite aqui">`;
  } else if (it.tipo === 'texto_amplo'){
    entrada = `<textarea data-in="${esc(it.id)}" placeholder="Descreva…">${esc(r || '')}</textarea>`;
  }
  const obs = it.obs ? `<textarea data-obs="${esc(it.id)}" placeholder="Observação (opcional)"
      style="margin-top:9px;min-height:58px">${esc(visita.obs[it.id] || '')}</textarea>` : '';
  return `<div class="item" data-item="${esc(it.id)}">
    <div class="enunciado">${esc(it.pergunta)}</div>
    <div class="meta">${prio}${tagFoto}${it.secao ? `<span>${esc(it.secao)}</span>` : ''}</div>
    ${entrada}${obs}
    <div class="fotos" data-fotos="${esc(it.id)}"></div>
  </div>`;
}

function ligarItens(chk, itens){
  $tela.querySelectorAll('[data-op]').forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.op, val = b.dataset.val;
      const it = itens.find(i => i.id === id);
      const jaMarcado = (val === 'Outro') ? ehOutro(it, visita.respostas[id]) : (visita.respostas[id] === val);
      visita.respostas[id] = jaMarcado ? '' : val;
      const r = visita.respostas[id];
      $tela.querySelectorAll(`[data-op="${CSS.escape(id)}"]`).forEach(x =>
        x.setAttribute('aria-pressed', String((r === x.dataset.val) || (x.dataset.val === 'Outro' && ehOutro(it, r)))));
      const cx = $tela.querySelector(`[data-outro="${CSS.escape(id)}"]`);
      if (cx){
        const mostrar = ehOutro(it, r);
        cx.classList.toggle('oculto', !mostrar);
        if (mostrar){ cx.value = (r === 'Outro') ? '' : r; cx.focus(); } else cx.value = '';
      }
      salvarDadosTecnicosSeCompleto(chk, visita);
      await BD.salvarVisita(visita);
      redesenhar(chk, itens);
    };
  });
  $tela.querySelectorAll('[data-in]').forEach(el => {
    el.oninput = () => { visita.respostas[el.dataset.in] = el.value; };
    el.onblur  = async () => { salvarDadosTecnicosSeCompleto(chk, visita); await BD.salvarVisita(visita); redesenhar(chk, itens); };
  });
  $tela.querySelectorAll('[data-outro]').forEach(el => {
    el.oninput = () => { visita.respostas[el.dataset.outro] = el.value.trim() || 'Outro'; };
    el.onblur  = async () => { salvarDadosTecnicosSeCompleto(chk, visita); await BD.salvarVisita(visita); redesenhar(chk, itens); };
  });
  $tela.querySelectorAll('[data-obs]').forEach(el => {
    el.oninput = () => { visita.obs[el.dataset.obs] = el.value; };
    el.onblur  = () => BD.salvarVisita(visita);
  });
  redesenhar(chk, itens);
}

async function desenharFotos(it){
  const cx = $tela.querySelector(`[data-fotos="${CSS.escape(it.id)}"]`);
  if (!cx) return;
  const ids = visita.fotos[it.id] || [];
  const precisa = (it.tipo === 'foto') || exigeFoto(it, visita.respostas[it.id]);
  const urls = await Promise.all(ids.map(urlFoto));
  cx.innerHTML = ids.map((fid,i) =>
      `<div class="miniatura"><img src="${urls[i]}" alt=""><button data-rm="${fid}" data-de="${esc(it.id)}"
        aria-label="Remover foto">×</button></div>`).join('') +
    `<label class="add-foto${precisa && ids.length === 0 ? ' exigida' : ''}">
       <span>📷</span><span>${precisa && ids.length===0 ? 'Foto obrigatória' : 'Adicionar'}</span>
       <input type="file" accept="image/*" capture="environment" multiple hidden data-cam="${esc(it.id)}">
     </label>`;
  cx.querySelector('[data-cam]').onchange = async e => {
    const arqs = [...e.target.files];
    e.target.value = '';
    for (const a of arqs){
      const blob = await comprimir(a);
      const fid = uid();
      await BD.salvarFoto(fid, blob);
      (visita.fotos[it.id] = visita.fotos[it.id] || []).push(fid);
    }
    await BD.salvarVisita(visita);
    const chk = CFG.checklists.find(c => c.id === visita.checklist);
    await desenharFotos(it);
    atualizarProgresso(chk);
    pintarItem(it);
  };
  cx.querySelectorAll('[data-rm]').forEach(b => {
    b.onclick = async () => {
      const fid = b.dataset.rm;
      visita.fotos[it.id] = (visita.fotos[it.id] || []).filter(x => x !== fid);
      await BD.apagarFoto(fid);
      if (urlsFoto.has(fid)){ URL.revokeObjectURL(urlsFoto.get(fid)); urlsFoto.delete(fid); }
      await BD.salvarVisita(visita);
      const chk = CFG.checklists.find(c => c.id === visita.checklist);
      await desenharFotos(it);
      atualizarProgresso(chk); pintarItem(it);
    };
  });
}

function pintarItem(it){
  const el = $tela.querySelector(`[data-item="${CSS.escape(it.id)}"]`);
  if (!el) return;
  const r = visita.respostas[it.id];
  const sit = situacao(it, r);
  const temFoto = (visita.fotos[it.id] || []).length > 0;
  const faltaFoto = ((it.tipo === 'foto') || exigeFoto(it, r)) && !temFoto;
  const respondido = it.tipo === 'foto' ? temFoto : !respostaVazia(it, r);
  el.classList.toggle('nao-conforme', sit === 'Não conforme');
  el.classList.toggle('respondido', respondido && !faltaFoto && sit !== 'Não conforme');
  el.classList.toggle('pendente-obrig', respondido && faltaFoto);
}

function redesenhar(chk, itens){
  for (const it of itens){
    const el = $tela.querySelector(`[data-item="${CSS.escape(it.id)}"]`);
    if (!el) continue;
    const mostra = visivel(it, visita.respostas);
    el.classList.toggle('oculto', !mostra);
    if (it._bloqueado) continue;
    if (mostra){ desenharFotos(it); pintarItem(it); }
  }
  atualizarProgresso(chk);
}

function atualizarProgresso(chk){
  const visiveis = itensDoChecklist(chk, visita).filter(it => visivel(it, visita.respostas));
  const falta = pendencias(chk, visita).length;
  const feito = visiveis.length - falta;
  const pct = visiveis.length ? Math.round(100 * feito / visiveis.length) : 0;
  const bar = document.getElementById('pbar'), txt = document.getElementById('ptxt');
  if (bar) bar.style.width = pct + '%';
  if (txt) txt.textContent = `${feito} de ${visiveis.length} concluídos${falta ? ` · ${falta} pendente${falta>1?'s':''}` : ' · tudo pronto'}`;
}

/* ===================== tela: revisão ===================== */
function telaRevisao(){
  liberarUrls();
  const chk = CFG.checklists.find(c => c.id === visita.checklist);
  const falta = pendencias(chk, visita);
  const visiveis = itensDoChecklist(chk, visita).filter(it => visivel(it, visita.respostas));
  const ncs = visiveis.filter(it => situacao(it, visita.respostas[it.id]) === 'Não conforme');
  const nas = visiveis.filter(it => situacao(it, visita.respostas[it.id]) === 'Não se aplica');
  const nFotos = Object.values(visita.fotos).reduce((a,b) => a + b.length, 0);

  const listaFalta = falta.length ? `
    <div class="aviso"><strong>${falta.length} item(ns) pendente(s).</strong> O relatório pode ser
    finalizado assim mesmo, mas o pendente fica registrado como “Não informado”.</div>
    ${falta.map(f => `<div class="linha-lista" data-ir="${esc(f.item.id)}">
      <div class="cresce"><div class="t" style="font-size:14px">${esc(f.item.pergunta)}</div>
      <div class="s">${f.semResposta ? 'sem resposta' : ''}${f.semResposta && f.semFoto ? ' · ' : ''}${f.semFoto ? 'falta foto' : ''}</div></div>
      <span style="color:var(--cinza);font-size:20px">›</span></div>`).join('')}` : '';

  const listaNC = ncs.length ? `<h2>Não conformidades (${ncs.length})</h2>
    ${ncs.map(it => `<div class="item nao-conforme">
      <div class="enunciado">${esc(it.pergunta)}</div>
      <div class="meta">resposta: <strong>${esc(visita.respostas[it.id])}</strong>${
        it.prioridade ? ` · <span class="tag ${CLASSE_PRIO[it.prioridade]||'media'}">${esc(it.prioridade)}</span>` : ''}</div>
      ${visita.obs[it.id] ? `<div style="font-size:13.5px">${esc(visita.obs[it.id])}</div>` : ''}
    </div>`).join('')}`
    : `<div class="cartao" style="text-align:center;color:var(--verde)">
         <strong>Nenhuma não conformidade registrada.</strong></div>`;

  montarTela({
    titulo: 'Revisão', sub: `${visita.loja.cod} · ${chk.titulo}`, voltar: telaChecklist,
    html: `
      <div class="cartao">
        <div style="display:flex;gap:14px;text-align:center">
          <div style="flex:1"><div style="font-size:26px;font-weight:700">${visiveis.length - falta.length}/${visiveis.length}</div>
            <div style="font-size:11.5px;color:var(--cinza)">respondidos</div></div>
          <div style="flex:1"><div style="font-size:26px;font-weight:700;color:${ncs.length?'var(--vermelho)':'var(--verde)'}">${ncs.length}</div>
            <div style="font-size:11.5px;color:var(--cinza)">não conformes</div></div>
          <div style="flex:1"><div style="font-size:26px;font-weight:700">${nas.length}</div>
            <div style="font-size:11.5px;color:var(--cinza)">não se aplica</div></div>
          <div style="flex:1"><div style="font-size:26px;font-weight:700">${nFotos}</div>
            <div style="font-size:11.5px;color:var(--cinza)">fotos</div></div>
        </div>
      </div>
      <div class="cartao" style="font-size:13.5px;color:#374151">
        <div><strong>Técnico:</strong> ${esc(visita.tecnico)}</div>
        <div><strong>Loja:</strong> ${esc(visita.loja.cod)} — ${esc(visita.loja.nome || 's/ nome')}</div>
        <div><strong>Início:</strong> ${dataBR(visita.criadoEm)}, ${horaBR(visita.criadoEm)}</div>
        <div><strong>Localização:</strong> ${esc(localTexto(visita.geo))}</div>
        ${visita.geo && visita.geo.erro ? `<button class="btn sec pq" id="bGeo2" style="margin-top:8px">Tentar obter GPS agora</button>` : ''}
      </div>
      ${listaFalta}${listaNC}`,
    barra: `<button class="btn sec" id="bVoltarChk" style="flex:1">Continuar editando</button>
            <button class="btn" id="bFinalizar" style="flex:1.4">Finalizar relatório</button>`
  });

  const g2 = document.getElementById('bGeo2');
  if (g2) g2.onclick = async () => { visita.geo = await pegarLocal(); await BD.salvarVisita(visita); telaRevisao(); };
  $tela.querySelectorAll('[data-ir]').forEach(el => el.onclick = () => {
    telaChecklist();
    setTimeout(() => {
      const alvo = $tela.querySelector(`[data-item="${CSS.escape(el.dataset.ir)}"]`);
      if (alvo) alvo.scrollIntoView({behavior:'smooth', block:'center'});
    }, 60);
  });
  document.getElementById('bVoltarChk').onclick = telaChecklist;
  document.getElementById('bFinalizar').onclick = async () => {
    visita.finalizada = true;
    visita.emitidoEm = new Date().toISOString();
    if (!visita.geo || visita.geo.erro){ const g = await pegarLocal(); if (!g.erro) visita.geo = g; }
    await BD.salvarVisita(visita);
    telaRelatorio();
  };
}

/* ===================== tela: relatório ===================== */
async function telaRelatorio(){
  liberarUrls();
  const chk = CFG.checklists.find(c => c.id === visita.checklist);
  const visiveis = itensDoChecklist(chk, visita).filter(it => visivel(it, visita.respostas));
  const cont = {Conforme:0, 'Não conforme':0, 'Não se aplica':0, Informativo:0, Pendente:0};
  for (const it of visiveis) cont[situacao(it, visita.respostas[it.id])]++;
  const avaliados = visiveis.length;

  const idsFoto = [];
  for (const it of visiveis) (visita.fotos[it.id] || []).forEach(f => idsFoto.push(f));
  const urls = Object.fromEntries(await Promise.all(idsFoto.map(async f => [f, await urlFoto(f)])));

  let linhas = '', secao = null;
  for (const it of visiveis){
    if (it.secao !== secao){ secao = it.secao; linhas += `<tr><td colspan="2" class="secao-rel">${esc(secao)}</td></tr>`; }
    const r = visita.respostas[it.id];
    const sit = situacao(it, r);
    const fotos = (visita.fotos[it.id] || []);
    const valor = (it.tipo === 'foto')
      ? (fotos.length ? `${fotos.length} foto(s) registrada(s)` : 'Não informado')
      : (r == null || r === '' ? 'Não informado' : r);
    linhas += `<tr><th>${esc(it.pergunta)}</th><td>
      <span class="${sit === 'Não conforme' ? 'nc' : ''}">${esc(valor)}</span>
      ${sit === 'Não conforme' ? ' <strong class="nc">— NÃO CONFORME</strong>' : ''}
      ${visita.obs[it.id] ? `<div style="color:#555;margin-top:3px"><em>Obs.: ${esc(visita.obs[it.id])}</em></div>` : ''}
      ${fotos.length ? `<div class="fotos-rel">${fotos.map(f => `<img src="${urls[f]}" alt="">`).join('')}</div>` : ''}
    </td></tr>`;
  }

  montarTela({
    titulo: 'Relatório', sub: `${visita.loja.cod} · ${dataBR(visita.criadoEm)}`, voltar: telaRelatorios,
    html: `
      <div class="aviso nao-imprime">Para salvar em PDF: toque em <strong>Gerar PDF</strong> e escolha
      “Salvar como PDF” na tela de impressão do celular.</div>
      <div id="relatorio">
      <table class="folha"><thead><tr><td class="topo"></td></tr></thead><tfoot><tr><td class="rodape"></td></tr></tfoot>
      <tbody><tr><td class="miolo">
        <h3>RELATÓRIO DE INSPEÇÃO DE MANUTENÇÃO</h3>
        <div class="rsub">${esc(chk.titulo)} · Atendimento Equipe Gerador — Grupo DMA</div>
        <table>
          <tr><th>Relatório nº</th><td>${esc(visita.id)}</td></tr>
          <tr><th>Responsável</th><td>${esc(visita.tecnico)}</td></tr>
          <tr><th>Data / Hora</th><td>${dataBR(visita.criadoEm)}, ${horaBR(visita.criadoEm)}</td></tr>
          <tr><th>Loja</th><td>${esc(visita.loja.cod)} — ${esc(visita.loja.nome || '')}</td></tr>
          ${visita.loja.endereco ? `<tr><th>Endereço</th><td>${esc(visita.loja.endereco)}</td></tr>` : ''}
          <tr><th>Geolocalização</th><td>${esc(localTexto(visita.geo))}</td></tr>
          ${visita.matricula ? `<tr><th>Matrícula do acompanhante</th><td>${esc(visita.matricula)}</td></tr>` : ''}
        </table>
        <table>
          <tr><th>Total avaliado</th><td>${avaliados}</td></tr>
          <tr><th>Conformes</th><td>${cont.Conforme + cont.Informativo}</td></tr>
          <tr><th>Não conformes</th><td class="${cont['Não conforme'] ? 'nc' : ''}">${cont['Não conforme']}</td></tr>
          <tr><th>Não aplicáveis</th><td>${cont['Não se aplica']}</td></tr>
        </table>
        <table>${linhas}</table>
        <div style="margin-top:16px;font-size:11.5px;color:#555">
          Declaro que o presente relatório registra com exatidão as condições técnicas e operacionais
          observadas durante a visita no estabelecimento.<br><br>
          Emissão: ${visita.emitidoEm ? dataBR(visita.emitidoEm) + ', ' + horaBR(visita.emitidoEm) : '—'}<br>
          <strong>${esc(visita.tecnico)}</strong>
        </div>
      </td></tr></tbody></table>
      </div>`,
    barra: `<button class="btn sec" id="bJson" style="flex:1">Exportar dados</button>
            <button class="btn" id="bPdf" style="flex:1.3">Gerar PDF</button>`
  });

  document.getElementById('bPdf').onclick = () => window.print();
  document.getElementById('bJson').onclick = () => exportarJSON(chk, visiveis);
}

function exportarJSON(chk, visiveis){
  const dados = {
    relatorio_id: visita.id, versao_checklist: CFG.versao,
    checklist: {id: chk.id, titulo: chk.titulo, bloco: chk.bloco},
    tecnico: visita.tecnico,
    loja: visita.loja,
    matricula_acompanhante: visita.matricula || null,
    data: dataBR(visita.criadoEm), hora: horaBR(visita.criadoEm),
    emissao: visita.emitidoEm || null,
    geolocalizacao: visita.geo || null,
    itens: visiveis.map(it => ({
      id: it.id, secao: it.secao, pergunta: it.pergunta,
      resposta: visita.respostas[it.id] ?? null,
      observacao: visita.obs[it.id] || null,
      situacao: situacao(it, visita.respostas[it.id]),
      prioridade: it.prioridade || null,
      qtd_fotos: (visita.fotos[it.id] || []).length
    }))
  };
  const nome = `relatorio_${visita.loja.cod}_${dataBR(visita.criadoEm).replace(/\//g,'-')}_${visita.id}.json`;
  const blob = new Blob([JSON.stringify(dados, null, 1)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ===================== partida ===================== */
function estadoRede(){
  const el = document.getElementById('rede');
  el.textContent = navigator.onLine ? 'online' : 'offline';
  el.classList.toggle('off', !navigator.onLine);
}
addEventListener('online', () => { estadoRede(); if (CFG) sincronizarCentral(); });
addEventListener('offline', estadoRede);

(async function iniciar(){
  estadoRede();
  try {
    CFG = await (await fetch('checklists.json', {cache:'no-cache'})).json();
    localStorage.setItem('cfgCache', JSON.stringify(CFG));
  } catch (e) {
    const c = localStorage.getItem('cfgCache');
    if (c) CFG = JSON.parse(c);
  }
  if (!CFG){
    $tela.innerHTML = `<div class="aviso erro">Não foi possível carregar os checklists.
      Conecte-se à internet uma vez para o app baixar a lista de perguntas.</div>`;
    return;
  }
  aplicarExtrasLocais();
  await telaInicio();
  sincronizarCentral();   // em segundo plano: envia o que estiver pendente e baixa a base central
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
})();
