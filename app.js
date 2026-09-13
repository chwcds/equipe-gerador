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
  if (!item.foto) return false;
  if (item.foto.sempre) return true;
  if (item.foto.quando) return resp != null &&
    String(resp).trim().toLowerCase() === String(item.foto.quando).trim().toLowerCase();
  return false;
}

/* item pendente = visível, sem resposta, ou com foto exigida faltando */
function pendencias(chk, v){
  const faltando = [];
  for (const it of chk.itens){
    if (!visivel(it, v.respostas)) continue;
    const r = v.respostas[it.id];
    const semResposta = (it.tipo === 'foto') ? false : (r == null || r === '');
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

/* ===================== tela: início ===================== */
async function telaInicio(){
  visita = null;
  liberarUrls();
  const vs = (await BD.listarVisitas()).sort((a,b) => b.criadoEm.localeCompare(a.criadoEm));
  const linha = v => {
    const chk = CFG.checklists.find(c => c.id === v.checklist);
    const nc = v.finalizada ? contarNC(chk, v) : 0;
    return `<div class="linha-lista" data-abrir="${v.id}">
      <div class="cresce">
        <div class="t">${esc(v.loja.cod)} — ${esc(v.loja.nome || 'sem nome')}</div>
        <div class="s">${esc(chk ? chk.titulo : v.checklist)} · ${dataBR(v.criadoEm)} ${horaBR(v.criadoEm).slice(0,5)}${
          nc ? ` · <strong style="color:var(--vermelho)">${nc} não conforme${nc>1?'s':''}</strong>` : ''}</div>
      </div>
      <span class="pilula ${v.finalizada ? 'pronta' : 'rascunho'}">${v.finalizada ? 'finalizada' : 'rascunho'}</span>
    </div>`;
  };
  const rasc = vs.filter(v => !v.finalizada), fim = vs.filter(v => v.finalizada);
  montarTela({
    titulo: 'Equipe Gerador', sub: 'Grupo DMA',
    html: (vs.length === 0
      ? `<div class="vazio"><div class="ico">🔧</div>Nenhuma visita registrada ainda.<br>
         Toque em <strong>Nova visita</strong> para começar.</div>`
      : '') +
      (rasc.length ? `<h2>Em andamento</h2>${rasc.map(linha).join('')}` : '') +
      (fim.length  ? `<h2>Finalizadas</h2>${fim.map(linha).join('')}` : ''),
    barra: `<button class="btn" id="bNova">+ Nova visita</button>`
  });
  document.getElementById('bNova').onclick = telaNovaVisita;
  $tela.querySelectorAll('[data-abrir]').forEach(el => {
    el.onclick = async () => {
      visita = await BD.lerVisita(el.dataset.abrir);
      visita.finalizada ? telaRelatorio() : telaChecklist();
    };
  });
}

function contarNC(chk, v){
  if (!chk) return 0;
  return chk.itens.filter(it => visivel(it, v.respostas) &&
    situacao(it, v.respostas[it.id]) === 'Não conforme').length;
}

/* ===================== tela: nova visita ===================== */
async function telaNovaVisita(){
  liberarUrls();
  const salvos = JSON.parse(localStorage.getItem('tecnicosSalvos') || '[]');
  const lista = [...new Set([...(CFG.tecnicos || []), ...salvos])];
  const ultimo = localStorage.getItem('ultimoTecnico') || '';
  montarTela({
    titulo: 'Nova visita', voltar: telaInicio,
    html: `
    <div class="cartao">
      <label class="campo"><span>Técnico responsável</span>
        <input type="text" id="fTec" list="tecnicos" placeholder="Seu nome completo"
               autocomplete="name" enterkeyhint="next" value="${esc(ultimo)}">
        <datalist id="tecnicos">${lista.map(t =>
          `<option value="${esc(t)}"></option>`).join('')}</datalist></label>

      <label class="campo"><span>Loja</span>
        <input type="search" id="fLoja" list="lojas" placeholder="Código ou nome — ex.: D005"
               autocomplete="off" enterkeyhint="done">
        <datalist id="lojas">${(CFG.lojas || []).map(l =>
          `<option value="${esc(l.cod)} — ${esc(l.nome)}"></option>`).join('')}</datalist>
      </label>
      <div id="lojaInfo" class="s" style="font-size:12.5px;color:var(--cinza);margin:-8px 0 14px"></div>

      <label class="campo"><span>Endereço (opcional)</span>
        <input type="text" id="fEnd" placeholder="Preenchido automaticamente se a loja for conhecida"></label>

      <label class="campo"><span>Matrícula do gerente que acompanhou</span>
        <input type="number" id="fMat" inputmode="numeric" placeholder="Ex.: 653335"></label>
    </div>

    <div class="cartao">
      <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:6px">Localização da visita</div>
      <div id="geo" style="font-size:13px;color:var(--cinza)">Obtendo GPS…</div>
      <button class="btn sec pq" id="bGeo" style="margin-top:9px">Atualizar localização</button>
    </div>

    <h2>Qual checklist?</h2>
    ${CFG.checklists.map(c => `
      <div class="linha-lista" data-chk="${c.id}">
        <div class="cresce"><div class="t">${esc(c.titulo)}</div>
        <div class="s">${c.itens.length} itens · ${c.itens.filter(i=>i.foto).length} com foto</div></div>
        <span style="color:var(--cinza);font-size:20px">›</span>
      </div>`).join('')}
    <div id="erroNova"></div>`
  });

  const $tec = document.getElementById('fTec');
  let geo = null;
  const $geo = document.getElementById('geo');
  const buscarGeo = async () => {
    $geo.textContent = 'Obtendo GPS…';
    geo = await pegarLocal();
    $geo.textContent = localTexto(geo);
    $geo.style.color = geo.erro ? 'var(--ambar)' : 'var(--verde)';
  };
  buscarGeo();
  document.getElementById('bGeo').onclick = buscarGeo;

  const $loja = document.getElementById('fLoja'), $end = document.getElementById('fEnd');
  const $info = document.getElementById('lojaInfo');
  $loja.oninput = () => {
    const cod = $loja.value.split('—')[0].trim().toUpperCase();
    const l = (CFG.lojas || []).find(x => x.cod.toUpperCase() === cod);
    if (l){ $end.value = l.endereco || ''; $info.textContent = 'Loja conhecida dos relatórios anteriores.'; }
    else { $info.textContent = $loja.value ? 'Preencha o endereço se quiser que ele saia no relatório.' : ''; }
  };

  $tela.querySelectorAll('[data-chk]').forEach(el => {
    el.onclick = async () => {
      const tec = $tec.value.trim(), txtLoja = $loja.value.trim();
      const $err = document.getElementById('erroNova');
      if (!tec || !txtLoja){
        $err.innerHTML = `<div class="aviso erro">Informe o técnico e a loja antes de escolher o checklist.</div>`;
        $err.scrollIntoView({behavior:'smooth', block:'center'});
        return;
      }
      localStorage.setItem('ultimoTecnico', tec);
      const guard = JSON.parse(localStorage.getItem('tecnicosSalvos') || '[]');
      if (!guard.includes(tec)) localStorage.setItem('tecnicosSalvos', JSON.stringify([...guard, tec]));
      const partes = txtLoja.split('—');
      visita = {
        id: uid(), criadoEm: new Date().toISOString(), finalizada: false,
        tecnico: tec,
        loja: {cod: partes[0].trim().toUpperCase(), nome: (partes[1]||'').trim(),
               endereco: $end.value.trim()},
        matricula: document.getElementById('fMat').value.trim(),
        geo, checklist: el.dataset.chk, respostas: {}, obs: {}, fotos: {}
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
  let html = '';
  let secaoAtual = null;
  for (const it of chk.itens){
    if (it.secao !== secaoAtual){ secaoAtual = it.secao; html += `<h2>${esc(secaoAtual)}</h2>`; }
    html += htmlItem(it);
  }
  montarTela({
    titulo: chk.titulo,
    sub: `${visita.loja.cod} — ${visita.loja.nome || 's/ nome'} · ${visita.tecnico.split(' ')[0]}`,
    voltar: telaInicio,
    html: `<div class="progresso"><i id="pbar"></i></div><div class="prog-txt" id="ptxt"></div>${html}`,
    barra: `<button class="btn sec" id="bSalvar" style="flex:1">Salvar e sair</button>
            <button class="btn" id="bRevisar" style="flex:1.4">Revisar</button>`
  });
  ligarItens(chk);
  atualizarProgresso(chk);
  document.getElementById('bSalvar').onclick = async () => { await BD.salvarVisita(visita); telaInicio(); };
  document.getElementById('bRevisar').onclick = async () => { await BD.salvarVisita(visita); telaRevisao(); };
}

function htmlItem(it){
  const r = visita.respostas[it.id];
  const prio = it.prioridade ? `<span class="tag ${CLASSE_PRIO[it.prioridade]||'media'}">${esc(it.prioridade)}</span>` : '';
  const tagFoto = it.foto ? `<span class="tag foto">foto${it.foto.quando ? ` se ${esc(it.foto.quando)}` : ''}</span>` : '';
  let entrada = '';
  if (it.tipo === 'opcoes' || it.tipo === 'tristate'){
    entrada = `<div class="opcoes">${it.opcoes.map(o => {
      const cls = RUINS.includes(o.toLowerCase()) ? 'ruim'
                : o.toLowerCase().startsWith('não se aplica') ? 'na' : '';
      return `<button type="button" class="${cls}" data-op="${esc(it.id)}" data-val="${esc(o)}"
        aria-pressed="${r === o}">${esc(o)}</button>`;
    }).join('')}</div>`;
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

function ligarItens(chk){
  const porId = Object.fromEntries(chk.itens.map(i => [i.id, i]));

  $tela.querySelectorAll('[data-op]').forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.op, val = b.dataset.val;
      visita.respostas[id] = (visita.respostas[id] === val) ? '' : val;
      $tela.querySelectorAll(`[data-op="${CSS.escape(id)}"]`).forEach(x =>
        x.setAttribute('aria-pressed', String(visita.respostas[id] === x.dataset.val)));
      await BD.salvarVisita(visita);
      redesenhar(chk, porId);
    };
  });
  $tela.querySelectorAll('[data-in]').forEach(el => {
    el.oninput = () => { visita.respostas[el.dataset.in] = el.value; };
    el.onblur  = async () => { await BD.salvarVisita(visita); redesenhar(chk, porId); };
  });
  $tela.querySelectorAll('[data-obs]').forEach(el => {
    el.oninput = () => { visita.obs[el.dataset.obs] = el.value; };
    el.onblur  = () => BD.salvarVisita(visita);
  });
  redesenhar(chk, porId);
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
  const respondido = it.tipo === 'foto' ? temFoto : (r != null && r !== '');
  el.classList.toggle('nao-conforme', sit === 'Não conforme');
  el.classList.toggle('respondido', respondido && !faltaFoto && sit !== 'Não conforme');
  el.classList.toggle('pendente-obrig', respondido && faltaFoto);
}

function redesenhar(chk, porId){
  for (const it of chk.itens){
    const el = $tela.querySelector(`[data-item="${CSS.escape(it.id)}"]`);
    if (!el) continue;
    const mostra = visivel(it, visita.respostas);
    el.classList.toggle('oculto', !mostra);
    if (mostra){ desenharFotos(it); pintarItem(it); }
  }
  atualizarProgresso(chk);
}

function atualizarProgresso(chk){
  const visiveis = chk.itens.filter(it => visivel(it, visita.respostas));
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
  const visiveis = chk.itens.filter(it => visivel(it, visita.respostas));
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
  const visiveis = chk.itens.filter(it => visivel(it, visita.respostas));
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
    titulo: 'Relatório', sub: `${visita.loja.cod} · ${dataBR(visita.criadoEm)}`, voltar: telaInicio,
    html: `
      <div class="aviso nao-imprime">Para salvar em PDF: toque em <strong>Gerar PDF</strong> e escolha
      “Salvar como PDF” na tela de impressão do celular.</div>
      <div id="relatorio">
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
addEventListener('online', estadoRede);
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
  telaInicio();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
})();
