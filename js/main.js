/*
 * AR-CAD Inspetor — interface principal (biblioteca, projeto, importação e AR).
 */
import { db, novoId } from './db.js';
import { importarArquivo } from './importer.js';
import { carregarGlb, prepararModelo, fmtMm, tamanhoPecaMm } from './modelo.js';
import { Visualizador3D, gerarMiniatura } from './visualizador3d.js';
import { SessaoAR, verificarSuporteAR, ESTADO } from './ar.js';

const $ = (s) => document.querySelector(s);
const estado = { projetos: [], pastaAtiva: '__todas', busca: '', atual: null, modelo: null, cad: null, vis: null, ar: null, suporteAR: null, substituindo: false };

function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.classList.remove('oculto'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('oculto'), ms); }
function mostrarTela(id) { document.querySelectorAll('.tela').forEach(t => t.classList.add('oculto')); $(id).classList.remove('oculto'); window.scrollTo(0, 0); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const dimTxt = (mm) => mm.map(v => fmtMm(v)).join(' × ');

// ================= BIBLIOTECA =================
async function atualizarBiblioteca() {
  estado.projetos = (await db.listarProjetos()).sort((a, b) => (b.criadoEm || 0) - (a.criadoEm || 0));
  const pastasCfg = await db.obterConfig('pastas', []);
  const pastas = [...new Set([...pastasCfg, ...estado.projetos.map(p => p.pasta).filter(Boolean)])].sort();
  const categorias = [...new Set(estado.projetos.map(p => p.categoria).filter(Boolean))].sort();
  $('#lista-pastas').innerHTML = pastas.map(p => `<option value="${esc(p)}">`).join('');
  $('#lista-categorias').innerHTML = categorias.map(p => `<option value="${esc(p)}">`).join('');

  const chips = [['__todas', 'Todas'], ...pastas.map(p => [p, p]), ['__sem', 'Sem pasta']];
  $('#pastas').innerHTML = chips.map(([v, t]) => `<button class="chip ${estado.pastaAtiva === v ? 'ativo' : ''}" data-pasta="${esc(v)}">${esc(t)}</button>`).join('');
  $('#pastas').querySelectorAll('.chip').forEach(b => b.onclick = () => { estado.pastaAtiva = b.dataset.pasta; atualizarBiblioteca(); });

  const q = estado.busca.toLowerCase();
  const lista = estado.projetos.filter(p =>
    (estado.pastaAtiva === '__todas' || (estado.pastaAtiva === '__sem' ? !p.pasta : p.pasta === estado.pastaAtiva)) &&
    (!q || (p.nome + ' ' + (p.categoria || '') + ' ' + (p.pasta || '')).toLowerCase().includes(q)));
  $('#grade-projetos').innerHTML = lista.map(cardHtml).join('');
  $('#vazio').classList.toggle('oculto', estado.projetos.length > 0);
  $('#grade-projetos').querySelectorAll('.card').forEach(c => c.onclick = () => abrirProjeto(c.dataset.id));

  const hist = estado.projetos.filter(p => p.vistoEm).sort((a, b) => b.vistoEm - a.vistoEm).slice(0, 8);
  $('#secao-historico').classList.toggle('oculto', !hist.length);
  $('#historico').innerHTML = hist.map(cardHtml).join('');
  $('#historico').querySelectorAll('.card').forEach(c => c.onclick = () => abrirProjeto(c.dataset.id));

  const e = await db.espaco();
  if (e && e.quota) $('#rodape-armazenamento').textContent = `Armazenamento usado no aparelho: ${(e.usage / 1048576).toFixed(0)} MB de ${(e.quota / 1048576).toFixed(0)} MB disponíveis para o app.`;
}
function cardHtml(p) {
  const d = p.resumo && p.resumo.tamanhoMm ? p.resumo.tamanhoMm.map(v => (v / 1000).toFixed(2)).join(' × ') + ' m' : '';
  return `<div class="card" data-id="${p.id}">${p.miniatura ? `<img src="${p.miniatura}" alt="">` : '<div class="sem-mini">sem miniatura</div>'}
  <div class="txt"><b>${esc(p.nome)}</b><small>${esc([p.pasta, p.categoria].filter(Boolean).join(' · ') || p.formato.toUpperCase())}</small><br><small>${d}</small></div></div>`;
}

// ================= IMPORTAÇÃO =================
function abrirImportacao(substituir) {
  estado.substituindo = !!substituir;
  const f = $('#form-importar'); f.reset();
  $('#dlg-titulo').textContent = substituir ? 'Substituir arquivo do projeto' : 'Importar projeto';
  $('#imp-progresso').classList.add('oculto'); $('#imp-avisos').innerHTML = '';
  $('#imp-opcoes-malha').classList.add('oculto'); $('#imp-opcoes-cad').classList.add('oculto');
  if (substituir && estado.atual) { $('#imp-nome').value = estado.atual.nome; $('#imp-pasta').value = estado.atual.pasta || ''; $('#imp-categoria').value = estado.atual.categoria || ''; $('#imp-eixo').value = estado.atual.eixoVertical || 'Y'; }
  $('#imp-ok').disabled = false;
  $('#dlg-importar').showModal();
}
$('#imp-arquivo').addEventListener('change', () => {
  const lista = [...$('#imp-arquivo').files]; const f = lista.find(x => !/\.leve\.glb$/i.test(x.name)) || lista[0]; if (!f) return;
  const fmt = CadCore.formatoPorNome(f.name);
  $('#imp-opcoes-malha').classList.toggle('oculto', !(fmt === 'stl' || fmt === 'obj'));
  $('#imp-opcoes-cad').classList.toggle('oculto', !['step', 'iges', 'brep'].includes(fmt));
  if (!$('#imp-nome').value) $('#imp-nome').value = f.name.replace(/\.[^.]+$/, '');
  $('#imp-avisos').innerHTML = fmt === 'solidworks-nativo' ? '<div>SLDPRT/SLDASM não pode ser lido fora do SolidWorks. No SolidWorks: Arquivo › Salvar como › STEP AP214. Depois importe o .STEP.</div>' : '';
});
$('#form-importar').addEventListener('submit', async (ev) => {
  if (ev.submitter && ev.submitter.value === 'cancel') return;
  ev.preventDefault();
  const todos = [...$('#imp-arquivo').files]; if (!todos.length) return;
  const arqLeve = todos.length > 1 ? todos.find(f => /\.leve\.glb$/i.test(f.name)) : null;
  const file = todos.find(f => f !== arqLeve);
  const prog = $('#imp-progresso'); prog.classList.remove('oculto'); $('#imp-ok').disabled = true; $('#imp-avisos').innerHTML = '';
  try {
    const r = await importarArquivo(file, {
      unidade: $('#imp-unidade').value, perfil: $('#imp-perfil').value, lod: $('#imp-lod').checked,
      progresso: (t) => { prog.textContent = t; }
    });
    if (arqLeve && r.formato === 'glb') r.glbLeve = new Uint8Array(await arqLeve.arrayBuffer());
    prog.textContent = 'Gerando miniatura…';
    const eixo = $('#imp-eixo').value;
    const { cena } = await carregarGlb(r.glbLeve || r.glb);
    const mod = prepararModelo(cena, { eixoVertical: eixo, semFusao: true });
    const mini = gerarMiniatura(mod); mod.descartar();
    const id = estado.substituindo && estado.atual ? estado.atual.id : novoId();
    const anterior = estado.substituindo && estado.atual ? estado.atual : {};
    const proj = Object.assign({}, anterior, {
      id, nome: $('#imp-nome').value.trim() || file.name, pasta: $('#imp-pasta').value.trim(), categoria: $('#imp-categoria').value.trim(),
      arquivoOrigem: file.name, formato: r.formato, eixoVertical: eixo, resumo: r.resumo, avisos: r.avisos, miniatura: mini,
      criadoEm: anterior.criadoEm || Date.now(), atualizadoEm: Date.now(), escalaAutorizada: false,
      tamanhoGlb: r.glb.byteLength, temLeve: !!r.glbLeve
    });
    await db.salvarArquivos({ id, glb: new Blob([r.glb], { type: 'model/gltf-binary' }), glbLeve: r.glbLeve ? new Blob([r.glbLeve], { type: 'model/gltf-binary' }) : null });
    await db.salvarProjeto(proj);
    await db.pedirPersistencia();
    $('#dlg-importar').close();
    await atualizarBiblioteca();
    toast(r.avisos.length ? 'Importado com avisos — confira as dimensões.' : 'Projeto importado.');
    abrirProjeto(id);
  } catch (e) {
    prog.classList.add('oculto');
    $('#imp-avisos').innerHTML = `<div>${esc(e.message || e)}</div>`;
    $('#imp-ok').disabled = false;
  }
});

// ================= PROJETO =================
async function abrirProjeto(id) {
  const p = await db.obterProjeto(id); if (!p) return;
  estado.atual = p;
  mostrarTela('#tela-projeto');
  $('#proj-titulo').textContent = p.nome; $('#proj-nome').value = p.nome; $('#proj-pasta').value = p.pasta || ''; $('#proj-categoria').value = p.categoria || ''; $('#proj-eixo').value = p.eixoVertical || 'Y';
  $('#proj-peca').classList.add('oculto'); $('#lista-pecas').classList.add('oculto');
  renderDimensoes(p);
  if (!estado.vis) {
    estado.vis = new Visualizador3D($('#canvas-3d'));
    let t0 = 0;
    $('#canvas-3d').addEventListener('pointerdown', () => { t0 = performance.now(); });
    $('#canvas-3d').addEventListener('pointerup', (e) => { if (performance.now() - t0 < 250) selecionarNoVisor(e); });
  }
  await carregarModeloAtual();
}

async function carregarModeloAtual() {
  const p = estado.atual; const arq = await db.obterArquivos(p.id);
  if (!arq) { toast('Arquivo do projeto não encontrado.'); return; }
  $('#carregando-3d').classList.remove('oculto');
  liberarModelo();
  try {
    // Carregamento progressivo: nível leve primeiro (se houver), detalhe em seguida
    if (arq.glbLeve) {
      $('#carregando-3d').textContent = 'Carregando nível leve…';
      await usarGlb(new Uint8Array(await arq.glbLeve.arrayBuffer()), p);
      $('#carregando-3d').classList.add('oculto');
      toast('Visualização leve. Carregando detalhe completo…', 2000);
      const bytes = new Uint8Array(await arq.glb.arrayBuffer());
      if (estado.atual && estado.atual.id === p.id) { liberarModelo(); await usarGlb(bytes, p); toast('Detalhe completo carregado.', 1600); }
    } else {
      $('#carregando-3d').textContent = 'Carregando modelo…';
      await usarGlb(new Uint8Array(await arq.glb.arrayBuffer()), p);
    }
  } catch (e) { toast('Falha ao carregar o modelo: ' + e.message, 6000); }
  $('#carregando-3d').classList.add('oculto');
}
async function usarGlb(bytes, p) {
  const { cena, cad } = await carregarGlb(bytes);
  estado.modelo = prepararModelo(cena, { eixoVertical: p.eixoVertical || 'Y' });
  estado.cad = cad;
  estado.vis.mostrar(estado.modelo);
  renderDimensoes(p);
}
function liberarModelo() { if (estado.modelo) { if (estado.vis) estado.vis.liberar(); estado.modelo.descartar(); estado.modelo = null; } }

function renderDimensoes(p) {
  const r = p.resumo || {}; const m = estado.modelo;
  const linhas = [];
  if (r.tamanhoMm) linhas.push(['Medidas do arquivo (X × Y × Z)', dimTxt(r.tamanhoMm)]);
  if (m) {
    const t = m.tamanhoM; linhas.push(['Medidas exibidas: comprimento × altura × largura', dimTxt([t.x * 1000, t.y * 1000, t.z * 1000])]);
    linhas.push(['Peças / malhas', `${m.pecas.length}${m.fundido ? ` (fundidas em ${m.drawCalls} desenhos)` : ''}`]);
  }
  if (r.totalTriangulos) linhas.push(['Triângulos', Number(r.totalTriangulos).toLocaleString('pt-BR')]);
  linhas.push(['Origem', `${esc(p.arquivoOrigem || '')} (${(p.formato || '').toUpperCase()})`]);
  if (r.perfilTriangulacao) linhas.push(['Triangulação', r.perfilTriangulacao === 'detalhe' ? 'desvio de corda ≤ 0,3 mm' : r.perfilTriangulacao === 'leve' ? 'desvio de corda ≤ 5 mm' : 'desvio de corda ≤ 1 mm']);
  if (r.unidadeOrigem) linhas.push(['Unidade de origem', esc(r.unidadeOrigem)]);
  linhas.push(['Escala na AR', '1:1 (bloqueada)']);
  const avisos = (p.avisos || []).map(a => `<div class="aviso">${esc(a)}</div>`).join('');
  $('#proj-dim').innerHTML = `<b>Conferência dimensional</b><table>${linhas.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>${avisos}`;
}

function selecionarNoVisor(e) {
  const s = estado.vis.selecionar(e); const box = $('#proj-peca');
  if (!s || !s.peca) { estado.modelo && estado.modelo.destacar(null); box.classList.add('oculto'); return; }
  estado.modelo.destacar(s.peca);
  const t = tamanhoPecaMm(s.peca, 1);
  box.innerHTML = `<b>${esc(s.peca.nome)}</b><br>Caixa envolvente: ${dimTxt(t)}`;
  box.classList.remove('oculto');
}

$('#btn-voltar').onclick = () => { liberarModelo(); estado.atual = null; mostrarTela('#tela-inicio'); atualizarBiblioteca(); };
$('#btn-salvar').onclick = async () => {
  const p = estado.atual; const eixoMudou = $('#proj-eixo').value !== (p.eixoVertical || 'Y');
  Object.assign(p, { nome: $('#proj-nome').value.trim() || p.nome, pasta: $('#proj-pasta').value.trim(), categoria: $('#proj-categoria').value.trim(), eixoVertical: $('#proj-eixo').value });
  if (eixoMudou && estado.modelo) { await carregarModeloAtual(); const m = estado.modelo; p.miniatura = gerarMiniatura(m); estado.vis.mostrar(m); }
  await db.salvarProjeto(p); $('#proj-titulo').textContent = p.nome; toast('Salvo.');
};
$('#btn-excluir').onclick = async () => {
  if (!confirm(`Excluir "${estado.atual.nome}" do aparelho? Isso não pode ser desfeito.`)) return;
  await db.excluirProjeto(estado.atual.id); liberarModelo(); estado.atual = null; mostrarTela('#tela-inicio'); atualizarBiblioteca(); toast('Projeto excluído.');
};
$('#btn-substituir').onclick = () => abrirImportacao(true);
$('#btn-exportar').onclick = async () => {
  const arq = await db.obterArquivos(estado.atual.id); const a = document.createElement('a');
  a.href = URL.createObjectURL(arq.glb); a.download = (estado.atual.nome || 'modelo') + '.glb'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};
$('#btn-pecas').onclick = () => {
  const box = $('#lista-pecas'); if (!box.classList.contains('oculto')) { box.classList.add('oculto'); return; }
  const pecas = estado.modelo ? estado.modelo.pecas : [];
  box.innerHTML = `<b>Peças (${pecas.length})</b><div class="pecas-lista">${pecas.map(p => `<div><span>${esc(p.nome)}</span><span>${dimTxt(tamanhoPecaMm(p, 1))}</span></div>`).join('')}</div>`;
  box.classList.remove('oculto');
};

// ================= REALIDADE AUMENTADA =================
async function entrarAR() {
  if (!estado.modelo) { toast('Aguarde o modelo carregar.'); return; }
  const sup = estado.suporteAR || await verificarSuporteAR(); estado.suporteAR = sup;
  if (!sup.ok) { alert(sup.motivo); return; }
  const p = estado.atual; p.vistoEm = Date.now(); db.salvarProjeto(p);
  estado.vis.parar();
  const overlay = $('#ar-overlay'); overlay.classList.remove('oculto');
  document.body.classList.add('em-ar');
  resetOverlay();
  const ar = new SessaoAR(overlay, {
    estado: (e, s) => atualizarBotaoFixar(e, s),
    rastreamento: (r) => atualizarRastreamento(r),
    info: (i) => atualizarInfoAR(i),
    peca: (pc) => mostrarPecaAR(pc),
    medida: (m) => mostrarMedidaAR(m),
    escala: (v) => atualizarSeloEscala(v),
    fim: () => sairAR()
  });
  estado.ar = ar;
  try { await ar.iniciar(estado.modelo, estado.cad); }
  catch (e) { overlay.classList.add('oculto'); document.body.classList.remove('em-ar'); estado.vis.mostrar(estado.modelo); alert('Não foi possível iniciar a AR: ' + e.message); estado.ar = null; }
}
function sairAR() {
  $('#ar-overlay').classList.add('oculto'); document.body.classList.remove('em-ar');
  estado.ar = null;
  if (estado.modelo) estado.vis.mostrar(estado.modelo);
}
function resetOverlay() {
  $('#ar-peca').classList.add('oculto'); $('#ar-medida').classList.add('oculto'); $('#ar-escala-painel').classList.add('oculto');
  $('#ar-instrucao').classList.remove('oculto'); $('#ar-instrucao').textContent = 'Aponte a câmera para o chão e mova o celular devagar até aparecer o círculo.';
  modoToque('inspecionar'); atualizarSeloEscala(1); $('#ar-ocultar').textContent = 'Ocultar';
}
function atualizarBotaoFixar(e) {
  const b = $('#ar-fixar');
  if (e === ESTADO.FIXADO) { b.textContent = 'DESAFIXAR'; b.classList.add('desafixar'); $('#ar-instrucao').classList.add('oculto'); toast('Posição fixada. Agora caminhe ao redor do equipamento.'); }
  else { b.textContent = 'FIXAR POSIÇÃO'; b.classList.remove('desafixar'); }
  $('#ar-girar-esq').disabled = $('#ar-girar-dir').disabled = (e === ESTADO.FIXADO);
}
function atualizarRastreamento(r) {
  const s = $('#ar-rastreamento'); const al = $('#ar-alerta');
  const mapa = { ok: ['Rastreamento OK', 'ok'], limitado: ['Rastreamento limitado', 'alerta'], perdido: ['Rastreamento perdido', 'erro'], pausado: ['Pausado', 'alerta'], iniciando: ['Iniciando…', ''] };
  const [t, c] = mapa[r] || [r, '']; s.textContent = t; s.className = 'selo ' + c;
  if (r === 'perdido' || r === 'limitado') {
    al.innerHTML = '<b>Referência do ambiente perdida.</b><br>Pare, aponte para o chão ou para superfícies com textura e boa luz, e mova o celular devagar. O equipamento volta à posição fixada quando o ARCore reconhecer o local.';
    al.classList.remove('oculto');
  } else al.classList.add('oculto');
}
function atualizarInfoAR(i) {
  const d = i.exibidoMm; const proj = i.projetoMm;
  $('#ar-info').innerHTML =
    `<b>${esc(estado.atual.nome)}</b><br>` +
    `Projeto: ${dimTxt(proj)}<br>` +
    `Exibido: ${dimTxt(d)} ${i.escala === 1 ? '✔ 1:1' : '<b style="color:#ff8a8d">≠ projeto</b>'}<br>` +
    `Fixação: ${i.fixacao}${i.distanciaM != null ? `<br>Distância até o modelo: ${i.distanciaM.toFixed(2).replace('.', ',')} m` : ''}`;
  if (!i.superficie && i.fixacao === 'posicionando') $('#ar-instrucao').textContent = 'Procurando o chão… mova o celular devagar, mostrando o piso.';
  else if (i.fixacao === 'posicionando') $('#ar-instrucao').textContent = 'Arraste para os lados para girar. Ande até o lugar desejado e toque em FIXAR POSIÇÃO.';
}
function mostrarPecaAR(pc) {
  const b = $('#ar-peca'); if (!pc) { b.classList.add('oculto'); return; }
  b.innerHTML = `<b>${esc(pc.nome)}</b><br>Caixa envolvente: ${dimTxt(pc.tamanhoMm)}<br>Você está a ${pc.distanciaM.toFixed(2).replace('.', ',')} m desta peça.`;
  b.classList.remove('oculto');
}
function mostrarMedidaAR(m) {
  const b = $('#ar-medida');
  if (m.tipo === 'modelo') b.innerHTML = `<b>Medida no modelo</b><br>${fmtMm(m.mm)} (projeto)${Math.abs(m.mmExibido - m.mm) > 0.05 ? `<br>exibido: ${fmtMm(m.mmExibido)}` : ''}`;
  else b.innerHTML = `<b>Trena real (ARCore)</b><br>${fmtMm(m.mm)}<br><small>Compare com uma trena física para validar a escala.</small>`;
  b.classList.remove('oculto');
}
function atualizarSeloEscala(v) {
  const s = $('#ar-escala');
  if (v === 1) { s.textContent = 'ESCALA 1:1'; s.className = 'selo ok'; }
  else { s.textContent = `ESCALA 1:${(1 / v).toFixed(v < 0.1 ? 0 : 1)} — NÃO É TAMANHO REAL`; s.className = 'selo erro'; }
}
function modoToque(m) {
  if (estado.ar) { estado.ar.modoToque = m; estado.ar.modoTrena = (m === 'trena'); }
  ['#ar-inspecionar', '#ar-medir', '#ar-trena'].forEach(id => $(id).classList.remove('ativo'));
  $({ inspecionar: '#ar-inspecionar', 'medir-modelo': '#ar-medir', trena: '#ar-trena' }[m]).classList.add('ativo');
}

$('#btn-ar').onclick = entrarAR;
$('#ar-fixar').onclick = () => {
  const ar = estado.ar; if (!ar) return;
  if (ar.estado === ESTADO.FIXADO) { ar.desafixar(); toast('Desafixado. O equipamento volta a seguir o círculo.'); }
  else if (!ar.fixar()) toast('Ainda não encontrei o chão. Mova o celular devagar mostrando o piso.');
};
$('#ar-girar-esq').onclick = () => estado.ar && estado.ar.girar(15);
$('#ar-girar-dir').onclick = () => estado.ar && estado.ar.girar(-15);
$('#ar-ocultar').onclick = () => { if (!estado.ar) return; const v = estado.ar.alternarVisivel(); $('#ar-ocultar').textContent = v ? 'Ocultar' : 'Mostrar'; };
$('#ar-reiniciar').onclick = () => { if (!estado.ar) return; estado.ar.reiniciar(); resetOverlay(); };
$('#ar-sair').onclick = () => estado.ar && estado.ar.encerrar();
$('#ar-inspecionar').onclick = () => modoToque('inspecionar');
$('#ar-medir').onclick = () => { modoToque('medir-modelo'); toast('Toque em dois pontos do equipamento.'); };
$('#ar-trena').onclick = () => {
  if (!estado.ar) return;
  if (!estado.ar.modoTrena) { modoToque('trena'); toast('Mire o círculo no 1º ponto real e toque em Trena real de novo para marcar.'); return; }
  const r = estado.ar.marcarPontoTrena();
  if (!r) toast('Sem superfície sob o círculo.'); else if (r.parcial) toast('1º ponto marcado. Mire o 2º ponto e toque de novo.');
};
$('#ar-escala-btn').onclick = () => {
  if (!estado.atual.escalaAutorizada) {
    if (!confirm('A escala real é 1:1 e fica bloqueada. Autorizar mudança de escala só para visualização? Medidas exibidas deixarão de ser em tamanho real (o selo fica vermelho).')) return;
    estado.atual.escalaAutorizada = true; db.salvarProjeto(estado.atual);
  }
  $('#ar-escala-painel').classList.toggle('oculto');
};
$('#ar-escala-faixa').oninput = (e) => { const v = +e.target.value; estado.ar && estado.ar.definirEscala(v); atualizarSeloEscala(v); };
$('#ar-escala-1').onclick = () => { $('#ar-escala-faixa').value = 1; estado.ar && estado.ar.definirEscala(1); atualizarSeloEscala(1); };
$('#ar-escala-fechar').onclick = () => $('#ar-escala-painel').classList.add('oculto');

// ================= INÍCIO =================
$('#btn-importar').onclick = () => abrirImportacao(false);
$('#btn-camera').onclick = async () => {
  const ult = estado.projetos.filter(p => p.vistoEm).sort((a, b) => b.vistoEm - a.vistoEm)[0] || estado.projetos[0];
  if (!ult) { toast('Importe um projeto primeiro.'); return; }
  await abrirProjeto(ult.id);
  toast(`Projeto selecionado: ${ult.nome}. Toque em VISUALIZAR EM REALIDADE AUMENTADA.`, 4000);
};
$('#btn-nova-pasta').onclick = async () => {
  const n = (prompt('Nome da nova pasta:') || '').trim(); if (!n) return;
  const pastas = await db.obterConfig('pastas', []); if (!pastas.includes(n)) pastas.push(n);
  await db.salvarConfig('pastas', pastas); estado.pastaAtiva = n; atualizarBiblioteca();
};
$('#busca').oninput = (e) => { estado.busca = e.target.value; atualizarBiblioteca(); };

(async function iniciar() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  const sup = await verificarSuporteAR(); estado.suporteAR = sup;
  if (!sup.ok) { const a = $('#aviso-ar'); a.textContent = sup.motivo + ' Você ainda pode importar e inspecionar os projetos em 3D.'; a.classList.remove('oculto'); }
  await atualizarBiblioteca();
})();
