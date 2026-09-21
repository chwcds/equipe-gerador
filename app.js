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
      t.onabort = () => err(t.error || new Error('transação abortada'));
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
const VERSAO_APP = '31';
const DATA_VERSAO = '21/09/2026';

/* ===================== estado ===================== */
let CFG = null;            // checklists.json (+ lojas.json)
let visita = null;         // visita em edição
let telaAtual = '';        // 'inicio' | 'andamento' | 'relatorios' | 'checklist' | 'revisao' | 'relatorio'
const urlsFoto = new Map();// id -> objectURL (liberados ao trocar de tela)

const uid = () => (Date.now().toString(36) + Math.random().toString(36).slice(2,8)).toUpperCase();
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// marcas de acento (U+0300 a U+036F) para tirar acentos de nomes; montado sem sequência de escape
const ACENTOS = new RegExp('[' + String.fromCharCode(768) + '-' + String.fromCharCode(879) + ']', 'g');

function dataBR(iso){
  const d = new Date(iso);
  const p = n => String(n).padStart(2,'0');
  return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()}`;
}
function horaBR(iso){
  const d = new Date(iso), p = n => String(n).padStart(2,'0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ===================== ícones (SVG inline) =====================
   Emojis mudam de desenho conforme a marca do celular; SVG fica igual em todos. */
const svg = d => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICO = {
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z"/><circle cx="12" cy="14" r="3.5"/>'),
  pino:   svg('<path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>'),
  mapa:   svg('<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>'),
  fone:   svg('<path d="M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z"/>'),
  lixo:   svg('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/><path d="M10 10v6M14 10v6"/>'),
  ok:     svg('<path d="M20 6L9 17l-5-5"/>'),
  doc:    svg('<path d="M6 2h8l6 6v14H6z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>'),
  fechar: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  gps:    svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/>'),
  alerta: svg('<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v.5"/>'),
  apagar: svg('<path d="M20 6H9l-6 6 6 6h11a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1z"/><path d="M17 9l-6 6M11 9l6 6"/>'),
};

/* opção "Outro": o técnico digita o nome; a resposta gravada é o texto digitado
   (e não a palavra "Outro"), assim o PDF e o cadastro da loja recebem o nome real */
function temOutro(it){ return it.tipo === 'opcoes' && (it.opcoes || []).includes('Outro'); }
function ehOutro(it, r){
  return temOutro(it) && r != null && r !== '' && !it.opcoes.filter(o => o !== 'Outro').includes(r);
}
function respostaVazia(it, r){ return r == null || r === '' || (r === 'Outro' && temOutro(it)); }

/* rede da visita: nas lojas do Supermercados BH valem as regras de foto de cada
   pergunta (obrigatória onde está marcada, opcional nas demais); nas lojas da DMA
   (EPA/Mineirão) nenhuma foto é obrigatória — o técnico pode fotografar se quiser */
function redeDaVisita(v){
  v = v || visita;
  if (!v || !v.loja) return null;
  const l = encontrarLoja(v.loja.cod);
  return (l && l.rede) || v.loja.rede || null;
}
function fotosDispensadas(rede){ return rede != null && rede !== 'Supermercados BH'; }

/* ===================== regra de conformidade =====================
   Perguntas numeradas (ou com prioridade) de Sim/Não são conformidade.
   Nas perguntas marcadas com "invertido" no checklists.json (ex.: "Existe vestígio
   de insetos?", "Possui vazamentos?"), o "Sim" é que é a não conformidade — a mesma
   marcação que pinta o botão "Sim" de vermelho na tela. */
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
  const sim = (r === 'sim');
  if (item.invertido) return sim ? 'Não conforme' : 'Conforme';
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
  if (item.tipo !== 'foto' && !item.foto) return false;
  if (fotosDispensadas(redeDaVisita())) return false;   // lojas da DMA: foto nunca é obrigatória (inclui itens tipo "foto")
  if (item.tipo === 'foto') return true;
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
   O cadastro técnico e os relatórios finalizados são compartilhados entre todos os
   aparelhos por uma planilha Google ("Equipe Gerador - Cadastro de Lojas", conta chwcds).
   Ordem de precedência ao montar a loja em memória:
     lojas.json  <  cópia local da base central  <  envios ainda pendentes deste aparelho.
   Tudo funciona offline: o que o técnico preenche entra numa fila e é enviado quando
   houver internet; a última cópia baixada da base central fica guardada no aparelho. */
const BASE_CENTRAL_URL = 'https://script.google.com/macros/s/AKfycbyMbRFI4qbTCtICWeC4xZdtVly9SIvNnlmoZ5pcbMpKSbuQdhAgQP0WldnXxFry89g2/exec';
const MAX_TENTATIVAS_ENVIO = 10;   // envios recusados pela planilha param de ser tentados (ficam registrados)
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
/* recompõe CFG.lojas a partir do lojas.json puro + base central + fila pendente.
   A lista de lojas é só a do banco de dados: o técnico não cadastra loja em campo
   (inclusão de loja nova é feita pelo back-end, no lojas.json). */
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
const chaveFila = it => `${it.tipo}|${it.cod}|${it.bloco || ''}`;
/* entra na fila (substituindo item igual) e tenta enviar */
function enfileirarCentral(item){
  const fila = lerLS('filaCentral', []);
  const i = fila.findIndex(it => chaveFila(it) === chaveFila(item));
  if (i >= 0) fila[i] = item; else fila.push(item);
  gravarLS('filaCentral', fila);
  atualizarStatusCentral();
  clearTimeout(enfileirarCentral._t);
  enfileirarCentral._t = setTimeout(enviarFilaCentral, 1500);
}
function atualizarItemFila(item){
  const fila = lerLS('filaCentral', []);
  const i = fila.findIndex(it => chaveFila(it) === chaveFila(item) && it.criadoEm === item.criadoEm);
  if (i >= 0){ fila[i] = item; gravarLS('filaCentral', fila); }
}
function removerDaFila(item){
  const fila = lerLS('filaCentral', []).filter(it => !(chaveFila(it) === chaveFila(item) && it.criadoEm === item.criadoEm));
  gravarLS('filaCentral', fila);
}
/* Envia UM item por vez: se a planilha recusar um relatório, os demais não ficam presos
   atrás dele. Falha de rede interrompe e tenta tudo de novo depois; recusa da planilha
   conta uma tentativa no item e segue para o próximo. */
async function enviarFilaCentral(){
  const fila = lerLS('filaCentral', []);
  if (!fila.length || central.enviando || !navigator.onLine) return;
  central.enviando = true; central.erro = null; atualizarStatusCentral();
  try {
    for (const item of fila){
      if ((item.tentativas || 0) >= MAX_TENTATIVAS_ENVIO) continue;
      let r;
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
        r = await fetch(BASE_CENTRAL_URL, {method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'},
          body: JSON.stringify({lote: [item]}), signal: ctl.signal});
        clearTimeout(t);
      } catch (e) {
        central.erro = 'sem conexão com a base central';
        break;                                   // sem rede: para aqui e tenta tudo de novo depois
      }
      let j = null;
      try { j = await r.json(); } catch (e) {}
      if (!j || !j.ok){
        item.tentativas = (item.tentativas || 0) + 1;
        item.ultimoErro = (j && j.erro) ? String(j.erro) : `resposta inválida (HTTP ${r.status})`;
        atualizarItemFila(item);
        continue;
      }
      removerDaFila(item);                       // enviado: sai da fila
      if (item.tipo === 'dadosTecnicos'){
        const cache = central.cache || {dadosTecnicos:{}};
        const k = `${item.cod}|${item.bloco}`;
        cache.dadosTecnicos[k] = Object.assign({}, cache.dadosTecnicos[k] || {}, item.dados);
        central.cache = cache; gravarLS('baseCentralCache', cache);
      }
      if (item.tipo === 'relatorio') await marcarRelatorioEnviado(item.cod);
    }
    localStorage.removeItem('lojasExtras'); localStorage.removeItem('dadosTecnicosExtras');
  } finally {
    central.enviando = false; atualizarStatusCentral();
  }
}
async function marcarRelatorioEnviado(id){
  try {
    const v = await BD.lerVisita(id);
    if (v && !v.enviadoEm){ v.enviadoEm = new Date().toISOString(); await BD.salvarVisita(v); }
    if (visita && visita.id === id && v) visita.enviadoEm = v.enviadoEm;
  } catch (e) {}
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
  const fila = lerLS('filaCentral', []);
  const recusados = fila.filter(it => (it.tentativas || 0) >= MAX_TENTATIVAS_ENVIO).length;
  const pend = fila.length - recusados;
  if (central.enviando) return 'Enviando para a base central…';
  const partes = [];
  if (central.ultimaSync) partes.push(`Base de lojas atualizada em ${dataBR(central.ultimaSync)} ${horaBR(central.ultimaSync).slice(0,5)}`);
  else partes.push('Base de lojas ainda não baixada');
  if (pend) partes.push(`${pend} envio${pend>1?'s':''} aguardando internet`);
  if (recusados) partes.push(`${recusados} envio${recusados>1?'s':''} recusado${recusados>1?'s':''} pela planilha`);
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

/* ao finalizar um relatório, manda todas as perguntas e respostas para a planilha central
   (aba "relatorios" com o resumo, e a aba do checklist específico — relatorios_rotina,
   relatorios_preventiva, relatorios_subestacao ou relatorios_capacitores — com uma coluna
   fixa por pergunta), na mesma fila offline dos dados técnicos — se não houver internet no
   momento, envia sozinho quando a rede voltar. Fotos não vão junto (só a quantidade); o
   relatório com as fotos continua disponível pelo PDF. */
function enviarRelatorioCentral(v){
  const chk = CFG.checklists.find(c => c.id === v.checklist);
  if (!chk) return;
  const visiveis = itensDoChecklist(chk, v).filter(it => visivel(it, v.respostas));
  const cont = {Conforme:0, 'Não conforme':0, 'Não se aplica':0, Informativo:0, Pendente:0};
  for (const it of visiveis) cont[situacao(it, v.respostas[it.id])]++;
  const nFotos = Object.values(v.fotos).reduce((a,b) => a + b.length, 0);
  const dados = {
    relatorio_id: v.id,
    checklist: {id: chk.id, titulo: chk.titulo, bloco: chk.bloco},
    tecnico: v.tecnico,
    loja: v.loja,
    matricula: v.matricula || '',
    data: dataBR(v.criadoEm), hora: horaBR(v.criadoEm),
    emissao: v.emitidoEm || null,
    geo: v.geo || null,
    totais: {
      avaliado: visiveis.length,
      conforme: cont.Conforme + cont.Informativo,
      naoConforme: cont['Não conforme'],
      naoAplicavel: cont['Não se aplica'],
      fotos: nFotos
    },
    itens: visiveis.map(it => ({
      id: it.id, secao: it.secao, pergunta: it.pergunta,
      resposta: v.respostas[it.id] ?? null,
      situacao: situacao(it, v.respostas[it.id]),
      prioridade: it.prioridade || null,
      observacao: v.obs[it.id] || null,
      qtd_fotos: (v.fotos[it.id] || []).length
    }))
  };
  enfileirarCentral({tipo:'relatorio', cod: v.id, dados, tecnico: v.tecnico || '', criadoEm: new Date().toISOString()});
}

/* item pendente = visível, sem resposta, ou com foto exigida faltando */
function pendencias(chk, v){
  const faltando = [];
  for (const it of itensDoChecklist(chk, v)){
    if (!visivel(it, v.respostas)) continue;
    const r = v.respostas[it.id];
    const semResposta = (it.tipo === 'foto') ? false : respostaVazia(it, r);
    const fotos = (v.fotos[it.id] || []);
    const semFoto = exigeFoto(it, r) && fotos.length === 0;
    if (semResposta || semFoto) faltando.push({item: it, semResposta, semFoto});
  }
  return faltando;
}

/* ===================== geolocalização =====================
   Tenta primeiro com alta precisão (GPS); se demorar ou falhar, tenta de novo aceitando
   precisão menor (torres/wi-fi) — dentro da sala do gerador o GPS puro costuma não pegar. */
function pedirPosicao(opts){
  return new Promise(ok => navigator.geolocation.getCurrentPosition(
    pos => ok({lat: +pos.coords.latitude.toFixed(6), lon: +pos.coords.longitude.toFixed(6),
               precisao: Math.round(pos.coords.accuracy), em: new Date().toISOString()}),
    e   => ok({erro: e.code === 1 ? 'Permissão de localização negada'
                    : e.code === 3 ? 'Tempo esgotado ao obter o GPS'
                    : 'Não foi possível obter a localização', codigo: e.code}),
    opts));
}
async function pegarLocal(){
  if (!navigator.geolocation) return {erro:'Aparelho sem GPS disponível'};
  let g = await pedirPosicao({enableHighAccuracy:true, timeout:15000, maximumAge:0});
  if (g.erro && g.codigo !== 1) g = await pedirPosicao({enableHighAccuracy:false, timeout:10000, maximumAge:60000});
  return g;
}
const geoOk = g => !!(g && !g.erro);
const localTexto = g => !g ? 'Localização ainda não obtida'
  : g.erro ? g.erro
  : `Lat: ${g.lat}, Long: ${g.lon} (Precisão: ${g.precisao}m)`;
/* a visita pode começar sem GPS: continua procurando em segundo plano e grava quando achar */
async function completarGeoDaVisita(id){
  const g = await pegarLocal();
  if (g.erro) return;
  if (visita && visita.id === id){ visita.geo = g; await salvar(); pintarGeoNaTela(); return; }
  try { const v = await BD.lerVisita(id); if (v && (!v.geo || v.geo.erro)){ v.geo = g; await BD.salvarVisita(v); } } catch (e) {}
}
function pintarGeoNaTela(){
  const el = document.getElementById('geoVisita');
  if (el) el.innerHTML = geoOk(visita && visita.geo) ? `${ICO.gps} Localização registrada` : `${ICO.gps} Obtendo localização…`;
}

/* ===================== avisos e confirmações (no lugar das caixas do navegador) ===================== */
function confirmar(msg, {ok = 'Confirmar', cancelar = 'Voltar', perigo = false, titulo = ''} = {}){
  return new Promise(res => {
    document.getElementById('modalConfirma')?.remove();
    const div = document.createElement('div');
    div.id = 'modalConfirma'; div.className = 'modal-fundo';
    div.innerHTML = `<div class="modal-caixa" role="dialog" aria-modal="true">
      ${titulo ? `<div class="modal-titulo">${esc(titulo)}</div>` : ''}
      <div class="modal-texto">${esc(msg)}</div>
      <div class="modal-acoes">
        <button type="button" class="btn sec" id="mcCancela">${esc(cancelar)}</button>
        <button type="button" class="btn ${perigo ? 'perigo-cheio' : ''}" id="mcOk">${esc(ok)}</button>
      </div></div>`;
    document.body.appendChild(div);
    const fechar = r => { div.remove(); res(r); };
    div.querySelector('#mcOk').onclick = () => fechar(true);
    div.querySelector('#mcCancela').onclick = () => fechar(false);
    div.addEventListener('click', e => { if (e.target === div) fechar(false); });
  });
}
function avisar(msg, tipo = 'erro'){
  let t = document.getElementById('toast');
  if (!t){ t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.className = `toast ${tipo}`; t.innerHTML = `${tipo === 'erro' ? ICO.alerta : ICO.ok} <span>${esc(msg)}</span>`;
  clearTimeout(avisar._t);
  avisar._t = setTimeout(() => t.classList.add('sumir'), 3500);
}
/* grava a visita em edição; se o aparelho recusar (sem espaço, modo anônimo), avisa em vez de perder em silêncio */
async function salvar(){
  if (!visita) return;
  try { await BD.salvarVisita(visita); }
  catch (e) { avisar('Não foi possível salvar no aparelho. Verifique o espaço livre do celular.'); }
}

/* ===================== dados da loja (modal) ===================== */
const TEL_CEMIG = '08007232827';
const formatarCNPJ = v => {
  const d = String(v || '').replace(/\D/g, '');
  return d.length === 14 ? `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}` : (v || '');
};
function fecharDadosLoja(){
  document.getElementById('modalLoja')?.remove();
}
function abrirDadosLoja(loja){
  fecharDadosLoja();
  const linha = (rotulo, valor) => valor ? `
    <div class="dado-linha"><span>${esc(rotulo)}</span><b>${esc(valor)}</b></div>` : '';
  const mapaUrl = loja.endereco ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loja.endereco)}` : '';
  const div = document.createElement('div');
  div.id = 'modalLoja';
  div.className = 'modal-fundo';
  div.innerHTML = `
    <div class="modal-caixa">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:16px">${esc(loja.cod)} — ${esc(loja.nome)}</div>
        </div>
        <button type="button" class="btn-voltar" id="bFecharDadosLoja" style="background:var(--fundo);color:var(--texto)" aria-label="Fechar">${ICO.fechar}</button>
      </div>
      ${linha('Endereço', loja.endereco || 'Endereço não cadastrado.')}
      ${mapaUrl ? `<a class="btn sec pq" href="${mapaUrl}" target="_blank" rel="noopener" style="margin:2px 0 12px">${ICO.mapa} Abrir no mapa</a>` : ''}
      ${linha('Regional', loja.regional)}
      ${linha('CNPJ', formatarCNPJ(loja.cnpj))}
      ${linha('Unidade consumidora', loja.unidade_consumidora)}
      ${loja.uf === 'MG' ? `<a class="btn pq" href="tel:${TEL_CEMIG}" style="margin-top:6px">${ICO.fone} Ligar para a Cemig</a>` : ''}
    </div>`;
  document.body.appendChild(div);
  div.addEventListener('click', e => { if (e.target === div) fecharDadosLoja(); });
  document.getElementById('bFecharDadosLoja').onclick = fecharDadosLoja;
}

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
  const reg = await BD.lerFoto(id).catch(() => null);
  if (!reg) return '';
  const u = URL.createObjectURL(reg.blob);
  urlsFoto.set(id, u);
  return u;
}
function liberarUrls(){
  for (const u of urlsFoto.values()) URL.revokeObjectURL(u);
  urlsFoto.clear();
}
/* Fotos de relatórios antigos já enviados à planilha são apagadas do aparelho depois de
   DIAS_GUARDAR_FOTOS dias, para o celular não encher. O relatório continua no aparelho
   (texto e quantidade de fotos); o PDF gerado na época é o registro com as imagens. */
const DIAS_GUARDAR_FOTOS = 60;
async function limparFotosAntigas(){
  try {
    const limite = Date.now() - DIAS_GUARDAR_FOTOS * 86400000;
    const vs = await BD.listarVisitas();
    for (const v of vs){
      if (!v.finalizada || !v.enviadoEm || v.fotosApagadasEm) continue;
      if (new Date(v.enviadoEm).getTime() > limite) continue;
      const qtd = {};
      for (const [itemId, ids] of Object.entries(v.fotos || {})){
        qtd[itemId] = ids.length;
        for (const fid of ids) await BD.apagarFoto(fid).catch(() => {});
      }
      v.qtdFotosApagadas = qtd; v.fotos = {}; v.fotosApagadasEm = new Date().toISOString();
      await BD.salvarVisita(v);
    }
  } catch (e) {}
}
const qtdFotosItem = (v, itemId) => (v.fotos[itemId] || []).length || ((v.qtdFotosApagadas || {})[itemId] || 0);

/* ===================== navegação ===================== */
const $tela = document.getElementById('tela');
const $titulo = document.getElementById('tituloTela');
const $voltar = document.getElementById('btnVoltar');
const $barra = document.getElementById('barra');
const $barraInt = document.getElementById('barraInterno');
let voltarPara = null;

const TITULO_APP = document.title;

/* nome dos arquivos gerados (PDF/JSON): RELATORIO_ROTINA_LOJA_D237_2026-09-04_ANDREI_PELOSI
   (tipo do checklist, código da loja, data da visita, dois primeiros nomes do técnico, sem
   acentos) — o tipo do checklist entra no início para não haver conflito de nome quando a
   mesma loja recebe mais de um checklist (ex.: rotina e preventiva) no mesmo dia */
function nomeArquivoRelatorio(v){
  const d = new Date(v.criadoEm), p = n => String(n).padStart(2,'0');
  const data = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  const tec = String(v.tecnico || '').normalize('NFD').replace(ACENTOS, '')
    .toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).join('_');
  const cod = String(v.loja?.cod || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const chkNome = String(v.checklist || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `RELATORIO_${chkNome ? chkNome + '_' : ''}LOJA_${cod}_${data}${tec ? '_' + tec : ''}`;
}

function montarTela({titulo, sub, voltar, html, barra}){
  document.title = TITULO_APP;
  $titulo.innerHTML = `<span>${esc(titulo)}</span>` + (sub ? `<small>${esc(sub)}</small>` : '');
  voltarPara = voltar || null;
  $voltar.classList.toggle('oculto', !voltar);
  $tela.innerHTML = html;
  if (barra){ $barraInt.innerHTML = barra; $barra.classList.remove('oculto'); }
  else $barra.classList.add('oculto');
  fecharTeclado();
  document.getElementById('toast')?.classList.add('sumir');
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
    ? `<button type="button" class="btn-excluir" data-excluir="${esc(v.id)}" aria-label="Excluir" title="Excluir">${ICO.lixo}</button>`
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
      const sim = await confirmar('As respostas e fotos desta visita serão apagadas do aparelho. Isso não pode ser desfeito.',
        {titulo:'Excluir visita em andamento?', ok:'Excluir', perigo:true});
      if (!sim) return;
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
    for (const fid of idsFoto) await BD.apagarFoto(fid).catch(() => {});
  }
  await BD.apagarVisita(id);
}
async function telaEmAndamento(){
  telaAtual = 'andamento';
  visita = null;
  liberarUrls();
  const vs = (await BD.listarVisitas()).filter(v => !v.finalizada).sort((a,b) => b.criadoEm.localeCompare(a.criadoEm));
  montarTela({
    titulo: 'Em andamento', sub: `${vs.length} visita${vs.length === 1 ? '' : 's'} para continuar`, voltar: telaInicio,
    html: vs.length
      ? `<div class="aviso">Toque na visita para continuar de onde parou. Tudo que foi respondido está guardado.</div>${vs.map(linhaVisita).join('')}`
      : `<div class="vazio"><div class="ico-grande">${ICO.ok}</div>Nenhuma visita em andamento.</div>`
  });
  ligarListaVisitas(telaEmAndamento);
}
async function telaRelatorios(){
  telaAtual = 'relatorios';
  visita = null;
  liberarUrls();
  const vs = (await BD.listarVisitas()).filter(v => v.finalizada).sort((a,b) => b.criadoEm.localeCompare(a.criadoEm));
  montarTela({
    titulo: 'Relatórios', sub: `${vs.length} relatório${vs.length === 1 ? '' : 's'} gerado${vs.length === 1 ? '' : 's'} neste aparelho`, voltar: telaInicio,
    html: vs.length
      ? vs.map(linhaVisita).join('')
      : `<div class="vazio"><div class="ico-grande">${ICO.doc}</div>Nenhum relatório gerado ainda.</div>`
  });
  ligarListaVisitas(telaRelatorios);
}

function contarNC(chk, v){
  if (!chk) return 0;
  return itensDoChecklist(chk, v).filter(it => visivel(it, v.respostas) &&
    situacao(it, v.respostas[it.id]) === 'Não conforme').length;
}

/* ===================== tela: início (técnico, rede, loja, checklist) ===================== */
async function telaInicio(){
  telaAtual = 'inicio';
  visita = null;
  liberarUrls();
  const ultimoTec = localStorage.getItem('ultimoTecnico') || '';
  const ultimaRede = localStorage.getItem('ultimaRede') || 'Supermercados BH';
  const redes = ['Supermercados BH', 'DMA'];
  const todas = await BD.listarVisitas().catch(() => []);
  const nAndamento = todas.filter(v => !v.finalizada).length, nRelatorios = todas.filter(v => v.finalizada).length;

  montarTela({
    titulo: 'Equipe Gerador', sub: `Grupo DMA · versão ${VERSAO_APP}`,
    html: `
    <div class="atalhos">
      <button type="button" class="btn sec" id="bAndamento">Em andamento${nAndamento ? ` <b>${nAndamento}</b>` : ''}</button>
      <button type="button" class="btn sec" id="bRelatorios">Relatórios${nRelatorios ? ` <b>${nRelatorios}</b>` : ''}</button>
    </div>
    <div class="cartao">
      <div class="campo"><span class="rotulo">Técnico responsável</span>
        <div class="opcoes coluna" id="fTec">
          ${(CFG.tecnicos || []).map(t =>
            `<button type="button" data-tec="${esc(t)}" aria-pressed="${t === ultimoTec ? 'true' : 'false'}">${esc(t)}</button>`).join('')}
        </div>
      </div>

      <div class="campo"><span class="rotulo">Rede que está atendendo</span>
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
      <div id="lojaInfo" class="s" style="font-size:12.5px;color:var(--cinza);margin:-8px 0 6px"></div>
      <button type="button" class="btn sec pq oculto" id="bDadosLoja" style="margin-bottom:10px">${ICO.pino} Ver dados da loja</button>

      <label class="campo" style="margin-top:14px"><span>Matrícula do gerente que acompanhou</span>
        <input type="number" id="fMat" inputmode="numeric" placeholder="Ex.: 653335"></label>
    </div>

    <div class="cartao geo-cartao">
      <div class="rotulo">Localização da visita</div>
      <div id="geo" class="geo-txt">${ICO.gps} Obtendo GPS…</div>
      <button class="btn sec pq oculto" id="bGeo" style="margin-top:9px">Tentar novamente</button>
    </div>

    <h2>Qual checklist?</h2>
    <div id="listaChecklists">
    ${CFG.checklists.map(c => `
      <div class="linha-lista" data-chk="${c.id}">
        <div class="cresce"><div class="t">${esc(c.titulo)}</div>
        <div class="s" data-resumo="${c.id}"></div></div>
        <span class="seta">›</span>
      </div>`).join('')}
    </div>
    <div id="erroNova"></div>
    <div class="status-central"><div id="statusCentral">${esc(textoStatusCentral())}</div>
      <div class="versao">Equipe Gerador — versão ${esc(VERSAO_APP)} (${esc(DATA_VERSAO)}) · base de lojas ${esc(CFG.versaoLojas || CFG.versao || '')}</div></div>`
  });
  document.getElementById('bAndamento').onclick = telaEmAndamento;
  document.getElementById('bRelatorios').onclick = telaRelatorios;

  const $tecBox = document.getElementById('fTec');
  const $redeBox = document.getElementById('fRede');
  // botões (não lista suspensa): .value devolve a opção marcada
  const marcado = (box, attr) => box.querySelector('button[aria-pressed="true"]')?.dataset[attr] || '';
  const $tec  = { get value(){ return marcado($tecBox, 'tec'); } };
  const $rede = { get value(){ return marcado($redeBox, 'rede'); } };
  const $loja = document.getElementById('fLoja'), $info = document.getElementById('lojaInfo');
  const $bDadosLoja = document.getElementById('bDadosLoja');
  const $lista = document.getElementById('listaChecklists');
  let geo = null, buscandoGeo = false;

  const atualizarInfoLoja = () => {
    const l = encontrarLoja($loja.value);
    $info.textContent = l ? (l.endereco || 'Endereço não cadastrado.') : '';
    $bDadosLoja.classList.toggle('oculto', !l);
    $bDadosLoja.onclick = l ? () => abrirDadosLoja(l) : null;
  };

  const atualizarResumos = () => {
    const dispensa = fotosDispensadas($rede.value);
    CFG.checklists.forEach(c => {
      const el = $lista.querySelector(`[data-resumo="${CSS.escape(c.id)}"]`);
      if (!el) return;
      const comFoto = c.itens.filter(i => i.foto).length;
      el.textContent = dispensa ? `${c.itens.length} itens · fotos opcionais` : `${c.itens.length} itens · ${comFoto} com foto`;
    });
  };
  const $busca = document.getElementById('fBuscaLoja');
  const normalizar = t => String(t || '').normalize('NFD').replace(ACENTOS, '').toUpperCase().trim();
  const numCod = c => { const n = parseInt(String(c).replace(/\D/g, ''), 10); return isNaN(n) ? Infinity : n; };
  // lista em ordem de código (D002, D003, ... / L001, L002, ...); a busca filtra por código ou nome
  const montarListaLojas = (manterSelecao) => {
    const redeSelecionada = $rede.value;
    const termo = normalizar($busca.value);
    const anterior = manterSelecao ? $loja.value : '';
    let lista = (CFG.lojas || []).filter(l => !redeSelecionada || l.rede === redeSelecionada);
    if (termo) lista = lista.filter(l => normalizar(l.cod).includes(termo) || normalizar(l.nome).includes(termo));
    lista.sort((a, b) => (numCod(a.cod) - numCod(b.cod)) || String(a.cod).localeCompare(String(b.cod)));
    const frag = document.createDocumentFragment();
    const vazio = document.createElement('option'); vazio.value = '';
    vazio.textContent = lista.length ? 'Selecione…' : 'Nenhuma loja encontrada';
    frag.appendChild(vazio);
    lista.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.cod;
      opt.textContent = `${l.cod} — ${l.nome}`;
      frag.appendChild(opt);
    });
    $loja.replaceChildren(frag);
    if (anterior && lista.some(l => l.cod === anterior)) $loja.value = anterior;
    else if (termo && lista.length === 1) $loja.value = lista[0].cod;   // só uma loja bate: já seleciona
    else $loja.value = '';
    atualizarInfoLoja();
  };
  const atualizarLojasComFiltro = () => {
    atualizarResumos();
    $busca.value = '';
    montarListaLojas(false);
  };
  let tBusca;
  $busca.oninput = () => { clearTimeout(tBusca); tBusca = setTimeout(() => montarListaLojas(true), 120); };

  $tecBox.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      $tecBox.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      localStorage.setItem('ultimoTecnico', b.dataset.tec);
    };
  });
  $redeBox.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      $redeBox.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      localStorage.setItem('ultimaRede', b.dataset.rede);
      atualizarLojasComFiltro();
    };
  });
  atualizarLojasComFiltro(); // já abre filtrada pela última rede usada

  /* GPS não trava o início: o técnico pode começar o checklist enquanto o aparelho
     procura a localização; ela é obrigatória só na hora de finalizar o relatório */
  const $geo = document.getElementById('geo'), $bGeo = document.getElementById('bGeo');
  const buscarGeo = async () => {
    if (buscandoGeo) return;
    buscandoGeo = true;
    $bGeo.classList.add('oculto');
    $geo.innerHTML = `${ICO.gps} Obtendo GPS… (pode começar o checklist enquanto isso)`; $geo.className = 'geo-txt';
    geo = await pegarLocal();
    buscandoGeo = false;
    if (telaAtual !== 'inicio') return;
    const ok = geoOk(geo);
    $geo.innerHTML = ok ? `${ICO.gps} ${esc(localTexto(geo))}`
      : `${ICO.alerta} ${esc(geo.erro)} — o app continua tentando; a localização é obrigatória para finalizar o relatório.`;
    $geo.className = ok ? 'geo-txt ok' : 'geo-txt erro';
    $bGeo.classList.toggle('oculto', ok);
  };
  buscarGeo();
  $bGeo.onclick = buscarGeo;

  $loja.onchange = atualizarInfoLoja;

  $lista.querySelectorAll('[data-chk]').forEach(el => {
    el.onclick = async () => {
      const $err = document.getElementById('erroNova');
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
        geo: geoOk(geo) ? geo : null, checklist: el.dataset.chk, respostas, obs: {}, fotos: {},
        _dtBloqueado: bloqueado
      };
      await salvar();
      if (!visita.geo) completarGeoDaVisita(visita.id);   // segue procurando em segundo plano
      telaChecklist();
    };
  });
}

/* ===================== tela: checklist ===================== */
const CLASSE_PRIO = {'Crítica':'critica','Alta':'alta','Média':'media','Media':'media'};
const RUINS = ['não','nao'];

function telaChecklist(){
  telaAtual = 'checklist';
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
    voltar: async () => { await salvar(); telaInicio(); },   // sair guarda a visita em "Em andamento"
    html: `<div class="progresso"><i id="pbar"></i></div><div class="prog-txt" id="ptxt"></div>
           <div class="geo-linha" id="geoVisita"></div>${html}`,
    barra: `<button class="btn perigo" id="bCancelar" style="flex:1">Cancelar relatório</button>
            <button class="btn" id="bRevisar" style="flex:1.4">Revisar e finalizar</button>`
  });
  pintarGeoNaTela();
  ligarItens(chk, itens);
  document.getElementById('bRevisar').onclick = async () => { await salvar(); telaRevisao(); };
  // desistir do relatório: apaga a visita e as fotos dela deste aparelho (não vai para "Em andamento")
  document.getElementById('bCancelar').onclick = async () => {
    const sim = await confirmar('Tudo que foi respondido e fotografado nesta visita será apagado. Isso não pode ser desfeito.',
      {titulo:'Cancelar este relatório?', ok:'Cancelar relatório', cancelar:'Continuar', perigo:true});
    if (!sim) return;
    await apagarVisitaCompleta(visita.id);
    visita = null;
    telaInicio();
  };
  const bCorr = document.getElementById('bCorrigirDT');
  if (bCorr) bCorr.onclick = async () => { visita._dtBloqueado = false; await salvar(); telaChecklist(); };
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
  if (it.foto && fotosDispensadas(redeDaVisita())) rotuloFoto = '';          // DMA: sem exigência de foto
  else if (it.foto && it.foto.quando) rotuloFoto = `foto se ${it.foto.quando}`;
  else if (it.foto) rotuloFoto = 'foto';
  const tagFoto = rotuloFoto ? `<span class="tag foto">${esc(rotuloFoto)}</span>` : '';
  let entrada = '';
  if (it.tipo === 'opcoes' || it.tipo === 'tristate'){
    // muitas opções (modelos de filtro, potências): grade fixa de 3 colunas, alinhada
    const grade = it.opcoes.length > 4 ? ' grade' : '';
    entrada = `<div class="opcoes${grade}">${it.opcoes.map(o => {
      // perguntas marcadas como invertido (ex.: "Existe vestígio de pragas?") têm o
      // "Não" como resposta esperada, então o alerta vermelho vai no "Sim"
      const ruim = it.invertido ? o.toLowerCase() === 'sim' : RUINS.includes(o.toLowerCase());
      const cls = ruim ? 'ruim'
                : o.toLowerCase().startsWith('não se aplica') ? 'na' : '';
      const marcado = (r === o) || (o === 'Outro' && ehOutro(it, r));
      return `<button type="button" class="${cls}" data-op="${esc(it.id)}" data-val="${esc(o)}"
        aria-pressed="${marcado}">${esc(o)}</button>`;
    }).join('')}</div>`;
    if (temOutro(it)){
      // opções numéricas (ex.: potência em kVA): o "Outro" abre o teclado numérico
      const numerico = it.opcoes.filter(o => o !== 'Outro').every(o => /^\d+([.,]\d+)?$/.test(o));
      entrada += `<input type="text" ${numerico ? 'inputmode="decimal"' : ''} data-outro="${esc(it.id)}" class="${ehOutro(it, r) ? '' : 'oculto'}"
        style="margin-top:9px" placeholder="${numerico ? 'Qual? Digite o valor' : 'Qual? Digite o nome'}" value="${esc(r === 'Outro' ? '' : (ehOutro(it, r) ? r : ''))}">`;
    }
  } else if (it.tipo === 'numero'){
    // medição: campo só-leitura que abre o teclado numérico único do app (painel embaixo),
    // sem abrir o teclado do celular
    entrada = `<input type="text" inputmode="none" readonly data-in="${esc(it.id)}" data-numero="1" class="visor-num"
       value="${esc(r || '')}" placeholder="Toque para digitar">`;
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

/* ---------- teclado numérico único (painel fixo embaixo) ---------- */
function abrirTeclado(it, input, aoMudar){
  let painel = document.getElementById('painelTeclado');
  if (!painel){
    painel = document.createElement('div');
    painel.id = 'painelTeclado'; painel.className = 'painel-teclado';
    painel.innerHTML = `<div class="pt-cab"><span id="ptRotulo"></span>
        <button type="button" class="pt-ok" id="ptFechar">${ICO.ok} OK</button></div>
      <div class="teclado-num">${['1','2','3','4','5','6','7','8','9',',','0','del','sep'].map(t =>
        `<button type="button" data-tecla="${t}" aria-label="${t === 'del' ? 'Apagar' : t === 'sep' ? 'Separar valores' : t}">${
          t === 'del' ? ICO.apagar : t === 'sep' ? '/ &nbsp;<small>separar valores (ex.: fases A / B / C)</small>' : t}</button>`).join('')}</div>`;
    document.body.appendChild(painel);
  }
  painel.querySelector('#ptRotulo').textContent = it.pergunta;
  painel.querySelector('#ptFechar').onclick = fecharTeclado;
  painel.querySelectorAll('[data-tecla]').forEach(b => {
    b.onclick = () => {
      let v = input.value || '';
      const t = b.dataset.tecla;
      if (t === 'del') v = v.endsWith(' / ') ? v.slice(0, -3) : v.slice(0, -1);
      else if (t === 'sep'){ if (v && !v.endsWith(' / ')) v += ' / '; }
      else if (t === ','){ const ultimo = v.split(' / ').pop(); if (ultimo && !ultimo.includes(',')) v += ','; }
      else v += t;
      input.value = v;
      aoMudar(v);
    };
  });
  document.querySelectorAll('.visor-num.ativo').forEach(x => x.classList.remove('ativo'));
  input.classList.add('ativo');
  document.body.classList.add('com-teclado');
  painel.classList.add('aberto');
  setTimeout(() => input.scrollIntoView({behavior:'smooth', block:'center'}), 50);
}
function fecharTeclado(){
  document.getElementById('painelTeclado')?.classList.remove('aberto');
  document.body.classList.remove('com-teclado');
  document.querySelectorAll('.visor-num.ativo').forEach(x => x.classList.remove('ativo'));
}

function ligarItens(chk, itens){
  const porId = new Map(itens.map(i => [i.id, i]));
  // grava e repinta só o item mexido (e os que dependem dele) — não a tela inteira
  const gravar = async (id) => { salvarDadosTecnicosSeCompleto(chk, visita); await salvar(); redesenharItem(chk, itens, id); };
  $tela.querySelectorAll('[data-op]').forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.op, val = b.dataset.val;
      const it = porId.get(id);
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
      await gravar(id);
    };
  });
  $tela.querySelectorAll('[data-in]').forEach(el => {
    const id = el.dataset.in;
    if (el.dataset.numero){
      el.onclick = () => abrirTeclado(porId.get(id), el, v => {
        visita.respostas[id] = v;
        clearTimeout(el._t);
        el._t = setTimeout(() => gravar(id), 400);
      });
      el.onfocus = () => el.blur();   // nunca abre o teclado do celular
      return;
    }
    el.oninput = () => { visita.respostas[id] = el.value; };
    el.onblur  = () => gravar(id);
  });
  $tela.querySelectorAll('[data-outro]').forEach(el => {
    el.oninput = () => { visita.respostas[el.dataset.outro] = el.value.trim() || 'Outro'; };
    el.onblur  = () => gravar(el.dataset.outro);
  });
  $tela.querySelectorAll('[data-obs]').forEach(el => {
    el.oninput = () => { visita.obs[el.dataset.obs] = el.value; };
    el.onblur  = () => salvar();
  });
  redesenhar(chk, itens);
}

async function desenharFotos(it){
  const cx = $tela.querySelector(`[data-fotos="${CSS.escape(it.id)}"]`);
  if (!cx) return;
  const ids = visita.fotos[it.id] || [];
  const precisa = exigeFoto(it, visita.respostas[it.id]);
  const urls = await Promise.all(ids.map(urlFoto));
  cx.innerHTML = ids.map((fid,i) =>
      `<div class="miniatura"><img src="${urls[i]}" alt=""><button type="button" data-rm="${fid}" data-de="${esc(it.id)}"
        aria-label="Remover foto">${ICO.fechar}</button></div>`).join('') +
    `<label class="add-foto${precisa && ids.length === 0 ? ' exigida' : ''}">
       ${ICO.camera}<span>${precisa && ids.length===0 ? 'Foto obrigatória' : 'Adicionar'}</span>
       <input type="file" accept="image/*" capture="environment" multiple hidden data-cam="${esc(it.id)}">
     </label>`;
  cx.querySelector('[data-cam]').onchange = async e => {
    const arqs = [...e.target.files];
    e.target.value = '';
    try {
      for (const a of arqs){
        const blob = await comprimir(a);
        const fid = uid();
        await BD.salvarFoto(fid, blob);
        (visita.fotos[it.id] = visita.fotos[it.id] || []).push(fid);
      }
    } catch (err) {
      avisar('Não foi possível guardar a foto. Verifique o espaço livre do celular.');
    }
    await salvar();
    const chk = CFG.checklists.find(c => c.id === visita.checklist);
    await desenharFotos(it);
    atualizarProgresso(chk);
    pintarItem(it);
  };
  cx.querySelectorAll('[data-rm]').forEach(b => {
    b.onclick = async () => {
      const fid = b.dataset.rm;
      visita.fotos[it.id] = (visita.fotos[it.id] || []).filter(x => x !== fid);
      await BD.apagarFoto(fid).catch(() => {});
      if (urlsFoto.has(fid)){ URL.revokeObjectURL(urlsFoto.get(fid)); urlsFoto.delete(fid); }
      await salvar();
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
  const faltaFoto = exigeFoto(it, r) && !temFoto;
  const respondido = it.tipo === 'foto' ? temFoto : !respostaVazia(it, r);
  el.classList.toggle('nao-conforme', sit === 'Não conforme');
  el.classList.toggle('respondido', respondido && !faltaFoto && sit !== 'Não conforme');
  el.classList.toggle('pendente-obrig', respondido && faltaFoto);
}

/* repinta um item e os que dependem dele (visibilidade condicional / foto por resposta) */
function redesenharItem(chk, itens, id){
  const alvo = itens.filter(it => it.id === id || (it.cond && it.cond.id === id));
  for (const it of alvo){
    const el = $tela.querySelector(`[data-item="${CSS.escape(it.id)}"]`);
    if (!el) continue;
    const mostra = visivel(it, visita.respostas);
    el.classList.toggle('oculto', !mostra);
    if (it._bloqueado) continue;
    if (mostra){ desenharFotos(it); pintarItem(it); }
  }
  atualizarProgresso(chk);
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
  telaAtual = 'revisao';
  liberarUrls();
  const chk = CFG.checklists.find(c => c.id === visita.checklist);
  const falta = pendencias(chk, visita);
  const visiveis = itensDoChecklist(chk, visita).filter(it => visivel(it, visita.respostas));
  const ncs = visiveis.filter(it => situacao(it, visita.respostas[it.id]) === 'Não conforme');
  const nas = visiveis.filter(it => situacao(it, visita.respostas[it.id]) === 'Não se aplica');
  const nFotos = Object.values(visita.fotos).reduce((a,b) => a + b.length, 0);
  const temGeo = geoOk(visita.geo);

  const listaFalta = falta.length ? `
    <div class="aviso"><strong>${falta.length} item(ns) pendente(s).</strong> O relatório pode ser
    finalizado assim mesmo, mas o pendente fica registrado como “Não informado”.</div>
    ${falta.map(f => `<div class="linha-lista" data-ir="${esc(f.item.id)}">
      <div class="cresce"><div class="t" style="font-size:14px">${esc(f.item.pergunta)}</div>
      <div class="s">${f.semResposta ? 'sem resposta' : ''}${f.semResposta && f.semFoto ? ' · ' : ''}${f.semFoto ? 'falta foto' : ''}</div></div>
      <span class="seta">›</span></div>`).join('')}` : '';

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
        <div class="resumo-nums">
          <div><b>${visiveis.length - falta.length}/${visiveis.length}</b><span>respondidos</span></div>
          <div><b style="color:${ncs.length?'var(--vermelho)':'var(--verde)'}">${ncs.length}</b><span>não conformes</span></div>
          <div><b>${nas.length}</b><span>não se aplica</span></div>
          <div><b>${nFotos}</b><span>fotos</span></div>
        </div>
      </div>
      <div class="cartao" style="font-size:13.5px;color:#374151">
        <div><strong>Técnico:</strong> ${esc(visita.tecnico)}</div>
        <div><strong>Loja:</strong> ${esc(visita.loja.cod)} — ${esc(visita.loja.nome || 's/ nome')}</div>
        <div><strong>Início:</strong> ${dataBR(visita.criadoEm)}, ${horaBR(visita.criadoEm)}</div>
        <div id="revGeo"><strong>Localização:</strong> ${esc(localTexto(visita.geo))}</div>
        ${temGeo ? '' : `<div class="aviso erro" style="margin-top:10px">A localização é obrigatória para finalizar. Ao tocar em
          <strong>Finalizar relatório</strong> o app tenta obter o GPS de novo — se não conseguir, vá para um local com sinal e tente outra vez.</div>
          <button class="btn sec pq" id="bGeo2">${ICO.gps} Tentar obter o GPS agora</button>`}
      </div>
      ${listaFalta}${listaNC}`,
    barra: `<button class="btn sec" id="bVoltarChk" style="flex:1">Continuar editando</button>
            <button class="btn" id="bFinalizar" style="flex:1.4">Finalizar relatório</button>`
  });

  const g2 = document.getElementById('bGeo2');
  if (g2) g2.onclick = async () => {
    g2.disabled = true; g2.textContent = 'Obtendo GPS…';
    visita.geo = await pegarLocal(); await salvar(); telaRevisao();
  };
  $tela.querySelectorAll('[data-ir]').forEach(el => el.onclick = () => {
    telaChecklist();
    setTimeout(() => {
      const alvo = $tela.querySelector(`[data-item="${CSS.escape(el.dataset.ir)}"]`);
      if (alvo) alvo.scrollIntoView({behavior:'smooth', block:'center'});
    }, 60);
  });
  document.getElementById('bVoltarChk').onclick = telaChecklist;
  const bFim = document.getElementById('bFinalizar');
  bFim.onclick = async () => {
    bFim.disabled = true;
    if (!geoOk(visita.geo)){
      bFim.textContent = 'Obtendo GPS…';
      const g = await pegarLocal();
      if (g.erro){
        visita.geo = g; await salvar();
        avisar('Sem localização: o relatório não pode ser finalizado ainda. Tente em um local com sinal de GPS.');
        telaRevisao();
        return;
      }
      visita.geo = g;
    }
    visita.finalizada = true;
    visita.emitidoEm = new Date().toISOString();
    await salvar();
    enviarRelatorioCentral(visita);
    telaRelatorio();
  };
}

/* ===================== tela: relatório ===================== */
async function telaRelatorio(){
  telaAtual = 'relatorio';
  liberarUrls();
  const chk = CFG.checklists.find(c => c.id === visita.checklist);
  const visiveis = itensDoChecklist(chk, visita).filter(it => visivel(it, visita.respostas));
  const cont = {Conforme:0, 'Não conforme':0, 'Não se aplica':0, Informativo:0, Pendente:0};
  for (const it of visiveis) cont[situacao(it, visita.respostas[it.id])]++;
  const avaliados = visiveis.length;
  const loja = encontrarLoja(visita.loja.cod) || visita.loja;

  const idsFoto = [];
  for (const it of visiveis) (visita.fotos[it.id] || []).forEach(f => idsFoto.push(f));
  const urls = Object.fromEntries(await Promise.all(idsFoto.map(async f => [f, await urlFoto(f)])));

  let linhas = '', secao = null;
  for (const it of visiveis){
    if (it.secao !== secao){ secao = it.secao; linhas += `<tr><td colspan="2" class="secao-rel">${esc(secao)}</td></tr>`; }
    const r = visita.respostas[it.id];
    const sit = situacao(it, r);
    const fotos = (visita.fotos[it.id] || []);
    const qtd = qtdFotosItem(visita, it.id);
    const valor = (it.tipo === 'foto')
      ? (qtd ? `${qtd} foto(s) registrada(s)` : 'Não informado')
      : (r == null || r === '' ? 'Não informado' : r);
    linhas += `<tr><th>${esc(it.pergunta)}</th><td>
      <span class="${sit === 'Não conforme' ? 'nc' : ''}">${esc(valor)}</span>
      ${sit === 'Não conforme' ? ' <strong class="nc">— NÃO CONFORME</strong>' : ''}
      ${visita.obs[it.id] ? `<div style="color:#555;margin-top:3px"><em>Obs.: ${esc(visita.obs[it.id])}</em></div>` : ''}
      ${fotos.length ? `<div class="fotos-rel">${fotos.map(f => `<img src="${urls[f]}" alt="">`).join('')}</div>`
        : (qtd && visita.fotosApagadasEm ? `<div style="color:#777;font-size:11px;margin-top:3px">${qtd} foto(s) — removidas do aparelho após ${DIAS_GUARDAR_FOTOS} dias; ver no PDF gerado na época.</div>` : '')}
    </td></tr>`;
  }
  const emissao = visita.emitidoEm ? `${dataBR(visita.emitidoEm)}, ${horaBR(visita.emitidoEm)}` : '—';
  const cabRep = `<div class="cab-rep"><img src="logo.png" alt="DMA"><div><b>Relatório de Inspeção de Manutenção</b>
      <span>${esc(chk.titulo)} · ${esc(visita.loja.cod)} — ${esc(visita.loja.nome || '')} · ${dataBR(visita.criadoEm)}</span></div></div>`;
  const rodRep = `<div class="rod-rep"><span>Equipe Gerador — Grupo DMA</span><span>Relatório ${esc(visita.id)} · emitido em ${esc(emissao)}</span></div>`;

  montarTela({
    titulo: 'Relatório', sub: `${visita.loja.cod} · ${dataBR(visita.criadoEm)}`, voltar: telaRelatorios,
    html: `
      <div class="aviso nao-imprime">Toque em <strong>Gerar relatório</strong>: os dados são exportados e, em
      seguida, escolha “Salvar como PDF” na tela de impressão do celular.</div>
      <div id="relatorio">
      <table class="folha"><thead><tr><td class="topo">${cabRep}</td></tr></thead><tfoot><tr><td class="rodape">${rodRep}</td></tr></tfoot>
      <tbody><tr><td class="miolo">
        <div class="rel-cab">
          <img src="logo.png" alt="DMA" class="rel-logo">
          <div class="rel-tit">
            <h3>RELATÓRIO DE INSPEÇÃO DE MANUTENÇÃO</h3>
            <div class="rsub">${esc(chk.titulo)} · Atendimento Equipe Gerador — Grupo DMA</div>
          </div>
          <div class="rel-num"><span>Relatório nº</span><b>${esc(visita.id)}</b></div>
        </div>
        <div class="rel-2col">
        <table>
          <tr><th>Loja</th><td>${esc(visita.loja.cod)} — ${esc(visita.loja.nome || '')}</td></tr>
          ${visita.loja.endereco ? `<tr><th>Endereço</th><td>${esc(visita.loja.endereco)}</td></tr>` : ''}
          ${loja.regional ? `<tr><th>Regional</th><td>${esc(loja.regional)}</td></tr>` : ''}
          ${loja.cnpj ? `<tr><th>CNPJ</th><td>${esc(formatarCNPJ(loja.cnpj))}</td></tr>` : ''}
        </table>
        <table>
          <tr><th>Responsável</th><td>${esc(visita.tecnico)}</td></tr>
          <tr><th>Data / Hora</th><td>${dataBR(visita.criadoEm)}, ${horaBR(visita.criadoEm)}</td></tr>
          <tr><th>Geolocalização</th><td>${esc(localTexto(visita.geo))}</td></tr>
          ${visita.matricula ? `<tr><th>Matrícula do acompanhante</th><td>${esc(visita.matricula)}</td></tr>` : ''}
        </table>
        </div>
        <div class="rel-totais">
          <div><b>${avaliados}</b><span>itens avaliados</span></div>
          <div class="ok"><b>${cont.Conforme + cont.Informativo}</b><span>conformes</span></div>
          <div class="${cont['Não conforme'] ? 'ruim' : ''}"><b>${cont['Não conforme']}</b><span>não conformes</span></div>
          <div><b>${cont['Não se aplica']}</b><span>não aplicáveis</span></div>
        </div>
        <table class="rel-itens">${linhas}</table>
        <div class="rel-decl">
          Declaro que o presente relatório registra com exatidão as condições técnicas e operacionais
          observadas durante a visita no estabelecimento. Emissão: ${esc(emissao)}.
        </div>
        <div class="rel-assin">
          <div><div class="linha"></div><b>${esc(visita.tecnico)}</b><span>Técnico responsável — Equipe Gerador</span></div>
          <div><div class="linha"></div><b>${visita.matricula ? 'Matrícula ' + esc(visita.matricula) : '&nbsp;'}</b><span>Gerente / responsável da loja</span></div>
        </div>
      </td></tr></tbody></table>
      </div>`,
    barra: `<button class="btn" id="bGerar" style="flex:1">${ICO.doc} Gerar relatório</button>`
  });

  // o título da página vira o nome sugerido do PDF em "Salvar como PDF"
  const nomeArq = nomeArquivoRelatorio(visita);
  document.title = nomeArq;
  document.getElementById('bGerar').onclick = () => {
    exportarJSON(chk, visiveis, nomeArq);
    document.title = nomeArq;
    window.print();
  };
}

function exportarJSON(chk, visiveis, nomeArq){
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
      qtd_fotos: qtdFotosItem(visita, it.id)
    }))
  };
  const nome = `${nomeArq || nomeArquivoRelatorio(visita)}.json`;
  const blob = new Blob([JSON.stringify(dados, null, 1)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ===================== partida =====================
   O app abre na hora com a cópia guardada no aparelho (service worker + localStorage) e
   confere em segundo plano se há perguntas ou lojas novas; se houver, troca sem o técnico
   perceber. Assim não fica em tela branca esperando a internet no subsolo da loja. */
function estadoRede(){
  const el = document.getElementById('rede');
  el.textContent = navigator.onLine ? 'online' : 'offline';
  el.classList.toggle('off', !navigator.onLine);
}
addEventListener('online', () => { estadoRede(); if (CFG){ sincronizarCentral(); atualizarBaseEmSegundoPlano(); } });
addEventListener('offline', estadoRede);

const comTempo = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('tempo esgotado')), ms))]);
async function carregarJSON(nome, opts){
  const r = await fetch(nome, opts);
  if (!r.ok) throw new Error(`${nome}: HTTP ${r.status}`);
  return r.json();
}
/* lojas vêm de lojas.json (arquivo separado, grande); versões antigas as traziam dentro do
   checklists.json. O sufixo "?atualizar=1" faz o service worker ir à rede e guardar no cache. */
async function carregarBase(opts, ms, sufixo = ''){
  const cfg = await comTempo(carregarJSON('checklists.json' + sufixo, opts), ms);
  if (!Array.isArray(cfg.lojas) || !cfg.lojas.length){
    const lj = await comTempo(carregarJSON('lojas.json' + sufixo, opts), ms);
    cfg.lojas = lj.lojas || []; cfg.versaoLojas = lj.versao || '';
  } else cfg.versaoLojas = cfg.versao || '';
  return cfg;
}
function guardarBaseLocal(cfg){
  // cópia de segurança no localStorage, gravada só quando a versão muda (é grande)
  const marca = `${cfg.versao}|${cfg.versaoLojas}`;
  if (localStorage.getItem('baseMarca') === marca) return;
  gravarLS('cfgCache', Object.assign({}, cfg, {lojas: undefined, _lojasBase: undefined}));
  gravarLS('lojasCache', {versao: cfg.versaoLojas, lojas: cfg.lojas});
  localStorage.setItem('baseMarca', marca);
}
function lerBaseLocal(){
  const cfg = lerLS('cfgCache', null);
  if (!cfg) return null;
  const lj = lerLS('lojasCache', null);
  cfg.lojas = (lj && lj.lojas) || cfg.lojas || [];
  cfg.versaoLojas = (lj && lj.versao) || cfg.versao || '';
  return cfg;
}
async function atualizarBaseEmSegundoPlano(){
  if (!navigator.onLine) return;
  try {
    const nova = await carregarBase({cache:'no-store'}, 20000, '?atualizar=1');
    if (!nova || (nova.versao === CFG.versao && nova.versaoLojas === CFG.versaoLojas)) return;
    CFG = nova;
    guardarBaseLocal(CFG);
    aplicarExtrasLocais();
    if (telaAtual === 'inicio' && !visita) telaInicio();
  } catch (e) {}
}

(async function iniciar(){
  estadoRede();
  try {
    CFG = await carregarBase({}, 8000);          // com service worker: vem do cache na hora
  } catch (e) {
    CFG = lerBaseLocal();
  }
  if (!CFG){
    $tela.innerHTML = `<div class="aviso erro">Não foi possível carregar os checklists.
      Conecte-se à internet uma vez para o app baixar a lista de perguntas.</div>
      <button class="btn" onclick="location.reload()">Tentar de novo</button>`;
    return;
  }
  guardarBaseLocal(CFG);
  aplicarExtrasLocais();
  await telaInicio();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
  sincronizarCentral();            // em segundo plano: envia o que estiver pendente e baixa a base central
  atualizarBaseEmSegundoPlano();   // em segundo plano: perguntas/lojas novas, se houver
  limparFotosAntigas();            // em segundo plano: fotos de relatórios antigos já enviados
})();
