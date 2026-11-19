import { supabase } from "@/lib/supabase/client";
import { AREAS_JURIDICAS, isAreaJuridica, type AreaJuridica } from "@/lib/advogados";
import { carregarCadastro, formatarDocumento, salvarCadastro, soDigitos, type ClienteCadastro, type TipoPessoa } from "@/lib/cadastro";
import { buscarFinanceiroFicha, moedaSemSimbolo, textoFormaPagamento } from "@/lib/financeiro";

/**
 * Modelos-base de documentos (Contrato de Honorários e Procuração Ad Judicia).
 * Preenchimento automático (migração v7): qualificação do cadastro do cliente
 * (clientes_cadastro, PF ou PJ) e valores/forma de pagamento do contrato de honorários
 * mais recente. Sem a v7, usa só o nome e o CPF da ficha. Alterações digitadas aqui só
 * vão para o cadastro se o usuário marcar "salvar no cadastro".
 * Os textos são modelos de partida: o advogado responsável deve revisá-los.
 */

export type ModeloDocumento = "contrato_honorarios" | "procuracao";

export const MODELOS: { valor: ModeloDocumento; label: string }[] = [
  { valor: "contrato_honorarios", label: "Contrato de honorários" },
  { valor: "procuracao", label: "Procuração ad judicia" },
];

export interface DadosDocumento {
  cliente_tipo: TipoPessoa;
  cliente_nome: string;
  cliente_nacionalidade: string;
  cliente_estado_civil: string;
  cliente_profissao: string;
  cliente_rg: string;
  cliente_cpf: string;
  cliente_endereco: string;
  /** PJ: representante legal e CPF dele. */
  representante_nome: string;
  representante_cpf: string;
  advogado_nome: string;
  advogado_oab: string;
  escritorio_endereco: string;
  area: AreaJuridica | "";
  objeto: string;
  honorarios_fixos: string;
  honorarios_percentual: string;
  forma_pagamento: string;
  foro: string;
  cidade: string;
  data: string; // yyyy-mm-dd
  poderes_especiais: boolean;
}

/** Dados do escritório lembrados neste navegador (não são dados de cliente). */
const CHAVE_ESCRITORIO = "crm-documentos-escritorio";
type DadosEscritorio = Pick<DadosDocumento, "advogado_oab" | "escritorio_endereco" | "cidade" | "foro">;

export function lerDadosEscritorio(): Partial<DadosEscritorio> {
  try {
    return JSON.parse(localStorage.getItem(CHAVE_ESCRITORIO) ?? "{}") as Partial<DadosEscritorio>;
  } catch {
    return {};
  }
}

export function lembrarDadosEscritorio(d: DadosDocumento) {
  const { advogado_oab, escritorio_endereco, cidade, foro } = d;
  localStorage.setItem(CHAVE_ESCRITORIO, JSON.stringify({ advogado_oab, escritorio_endereco, cidade, foro }));
}

export async function carregarDadosIniciais(fichaId: string): Promise<DadosDocumento> {
  const { data: ficha, error } = await supabase
    .from("fichas_clientes")
    .select("nome_cliente,cpf,area_identificada,advogado_id")
    .eq("id", fichaId)
    .maybeSingle<{ nome_cliente: string; cpf: string | null; area_identificada: string; advogado_id: string | null }>();
  if (error || !ficha) throw new Error("Não foi possível carregar a ficha (ou você não tem acesso a ela).");

  // Cadastro e honorários (v7): silenciosos se a migração ainda não existe.
  const [{ cadastro }, { contratos }] = await Promise.all([
    carregarCadastro(fichaId).catch(() => ({ cadastro: null as ClienteCadastro | null })),
    buscarFinanceiroFicha(fichaId).catch(() => ({ contratos: [] })),
  ]);
  const contrato = contratos.find((c) => !c.cancelado && (c.tipo === "honorarios" || c.tipo === "exito")) ?? contratos.find((c) => !c.cancelado);

  let advogadoNome = "";
  if (ficha.advogado_id) {
    const { data } = await supabase.from("advogados").select("nome").eq("id", ficha.advogado_id).maybeSingle<{ nome: string }>();
    advogadoNome = data?.nome ?? "";
  }
  const area = isAreaJuridica(ficha.area_identificada) ? ficha.area_identificada : "";
  const escritorio = lerDadosEscritorio();
  return {
    cliente_tipo: cadastro?.tipo_pessoa ?? "pf",
    cliente_nome: cadastro?.nome ?? ficha.nome_cliente,
    cliente_nacionalidade: cadastro?.nacionalidade ?? "brasileiro(a)",
    cliente_estado_civil: cadastro?.estado_civil ?? "",
    cliente_profissao: cadastro?.profissao ?? "",
    cliente_rg: cadastro?.rg ?? "",
    cliente_cpf: cadastro?.documento ? formatarDocumento(cadastro.documento) : formatarCpf(ficha.cpf ?? ""),
    cliente_endereco: cadastro?.endereco ?? "",
    representante_nome: cadastro?.representante_nome ?? "",
    representante_cpf: cadastro?.representante_cpf ? formatarDocumento(cadastro.representante_cpf) : "",
    advogado_nome: advogadoNome,
    advogado_oab: escritorio.advogado_oab ?? "",
    escritorio_endereco: escritorio.escritorio_endereco ?? "",
    area,
    objeto: contrato?.descricao
      ? contrato.descricao
      : area
        ? `atuação na demanda de Direito ${AREAS_JURIDICAS[area]} relatada pelo(a) contratante`
        : "",
    honorarios_fixos: contrato?.valor_total ? moedaSemSimbolo(contrato.valor_total) : "",
    honorarios_percentual: contrato?.percentual_exito ? String(contrato.percentual_exito).replace(".", ",") : "",
    forma_pagamento: (contrato && textoFormaPagamento(contrato)) || "à vista, na assinatura deste instrumento",
    foro: escritorio.foro ?? "",
    cidade: escritorio.cidade ?? "",
    data: new Date().toLocaleDateString("sv-SE"), // yyyy-mm-dd no fuso local
    poderes_especiais: false,
  };
}

export function formatarCpf(cpf: string): string {
  const d = cpf.replace(/\D/g, "");
  return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : cpf;
}

// ---------- geração de HTML (todas as variáveis são escapadas) ----------

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Valor preenchido ou marcador visível do campo faltante. */
const v = (valor: string, rotulo: string) =>
  valor.trim() ? esc(valor.trim()) : `<span class="vazio">[${esc(rotulo)}]</span>`;

function dataPorExtenso(iso: string): string {
  const d = iso ? new Date(`${iso}T12:00:00`) : new Date();
  return new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", year: "numeric" }).format(d);
}

function qualificacaoCliente(d: DadosDocumento) {
  if (d.cliente_tipo === "pj") {
    return `${v(d.cliente_nome, "razão social")}, pessoa jurídica de direito privado, inscrita no CNPJ sob o nº ${v(
      d.cliente_cpf,
      "CNPJ",
    )}, com sede em ${v(d.cliente_endereco, "endereço da sede com CEP")}, neste ato representada por ${v(
      d.representante_nome,
      "representante legal",
    )}, inscrito(a) no CPF sob o nº ${v(d.representante_cpf, "CPF do representante")}`;
  }
  return `${v(d.cliente_nome, "nome completo")}, ${v(d.cliente_nacionalidade, "nacionalidade")}, ${v(
    d.cliente_estado_civil,
    "estado civil",
  )}, ${v(d.cliente_profissao, "profissão")}, portador(a) do RG nº ${v(d.cliente_rg, "RG")}, inscrito(a) no CPF sob o nº ${v(
    d.cliente_cpf,
    "CPF",
  )}, residente e domiciliado(a) em ${v(d.cliente_endereco, "endereço completo com CEP")}`;
}

function qualificacaoAdvogado(d: DadosDocumento) {
  return `${v(d.advogado_nome, "nome do(a) advogado(a)")}, advogado(a) inscrito(a) na OAB/${v(
    d.advogado_oab,
    "UF e número",
  )}, integrante do escritório Dias e Fernandes Advocacia, com endereço profissional em ${v(
    d.escritorio_endereco,
    "endereço do escritório",
  )}`;
}

function rodapeAssinaturas(d: DadosDocumento, partes: { nome: string; papel: string }[], testemunhas: boolean) {
  const linhas = partes
    .map((p) => `<div class="assinatura"><div class="linha"></div><p>${p.nome}<br/><small>${p.papel}</small></p></div>`)
    .join("");
  const test = testemunhas
    ? `<div class="testemunhas"><p><strong>Testemunhas:</strong></p>
        <div class="assinatura"><div class="linha"></div><p>Nome:<br/>CPF:</p></div>
        <div class="assinatura"><div class="linha"></div><p>Nome:<br/>CPF:</p></div></div>`
    : "";
  return `<p class="local-data">${v(d.cidade, "cidade")}, ${dataPorExtenso(d.data)}.</p>${linhas}${test}`;
}

function contratoHonorarios(d: DadosDocumento): string {
  const area = d.area ? `Direito ${AREAS_JURIDICAS[d.area]}` : `<span class="vazio">[área do Direito]</span>`;
  const fixos = d.honorarios_fixos.trim();
  const perc = d.honorarios_percentual.trim();
  const clausulaHonorarios =
    fixos || perc
      ? [
          fixos ? `honorários fixos de R$ ${esc(fixos)}, pagos ${v(d.forma_pagamento, "forma de pagamento")}` : "",
          perc ? `honorários de êxito correspondentes a ${esc(perc)}% (por cento) do proveito econômico obtido pelo(a) CONTRATANTE` : "",
        ]
          .filter(Boolean)
          .join("; e ")
      : `<span class="vazio">[valor fixo e/ou percentual de êxito]</span>`;

  return `
<h1>Contrato de Prestação de Serviços Advocatícios e Honorários</h1>
<p><strong>CONTRATANTE:</strong> ${qualificacaoCliente(d)}.</p>
<p><strong>CONTRATADO(A):</strong> ${qualificacaoAdvogado(d)}.</p>
<p>As partes acima qualificadas celebram o presente contrato, que se regerá pelas cláusulas a seguir e pelo Estatuto da Advocacia e da OAB (Lei nº 8.906/1994) e pelo Código de Ética e Disciplina da OAB.</p>
<h2>Cláusula 1ª — Do objeto</h2>
<p>O(A) CONTRATADO(A) prestará ao(à) CONTRATANTE serviços advocatícios em matéria de ${area}, consistentes em ${v(d.objeto, "descrição dos serviços")}, abrangendo a prática dos atos judiciais e extrajudiciais necessários até a decisão final na instância em que for proposta a medida.</p>
<h2>Cláusula 2ª — Dos honorários</h2>
<p>Pelos serviços, o(a) CONTRATANTE pagará ${clausulaHonorarios}.</p>
<p>Parágrafo único. Os honorários de sucumbência, se houver, pertencem ao(à) CONTRATADO(A), nos termos do art. 23 da Lei nº 8.906/1994, sem compensação com os honorários aqui pactuados.</p>
<h2>Cláusula 3ª — Das despesas</h2>
<p>Custas processuais, emolumentos, honorários periciais, cópias, deslocamentos e demais despesas necessárias à causa correrão por conta do(a) CONTRATANTE, mediante prévia comunicação.</p>
<h2>Cláusula 4ª — Das obrigações do(a) contratante</h2>
<p>O(A) CONTRATANTE se obriga a fornecer, com veracidade e em tempo hábil, as informações e os documentos necessários, bem como a manter atualizados seus dados de contato.</p>
<h2>Cláusula 5ª — Da rescisão</h2>
<p>Qualquer das partes poderá rescindir este contrato mediante comunicação por escrito. Em caso de revogação do mandato ou rescisão por iniciativa do(a) CONTRATANTE, serão devidos os honorários proporcionais aos serviços já prestados, sem prejuízo dos honorários de êxito, se o resultado vier a ser obtido.</p>
<h2>Cláusula 6ª — Da proteção de dados</h2>
<p>Os dados pessoais do(a) CONTRATANTE serão tratados exclusivamente para a execução deste contrato e para o exercício regular de direitos, nos termos da Lei nº 13.709/2018 (LGPD).</p>
<h2>Cláusula 7ª — Do foro</h2>
<p>Fica eleito o foro da comarca de ${v(d.foro, "comarca")} para dirimir quaisquer dúvidas oriundas deste contrato.</p>
<p>E, por estarem justas e contratadas, as partes assinam o presente instrumento em duas vias de igual teor.</p>
${rodapeAssinaturas(
  d,
  [
    { nome: v(d.cliente_nome, "contratante"), papel: "CONTRATANTE" },
    { nome: v(d.advogado_nome, "advogado(a)"), papel: `CONTRATADO(A) — OAB/${v(d.advogado_oab, "UF nº")}` },
  ],
  true,
)}`;
}

function procuracao(d: DadosDocumento): string {
  const area = d.area ? ` (Direito ${AREAS_JURIDICAS[d.area]})` : "";
  const especiais = d.poderes_especiais
    ? `<p>Confere, ainda, os <strong>poderes especiais</strong> para receber citação, confessar, reconhecer a procedência do pedido, transigir, desistir, renunciar ao direito sobre o qual se funda a ação, receber, dar quitação, firmar compromisso e assinar declaração de hipossuficiência econômica, nos termos do art. 105 do Código de Processo Civil.</p>`
    : "";
  return `
<h1>Procuração <em>Ad Judicia et Extra</em></h1>
<p><strong>OUTORGANTE:</strong> ${qualificacaoCliente(d)}.</p>
<p><strong>OUTORGADO(A):</strong> ${qualificacaoAdvogado(d)}, onde recebe intimações.</p>
<p><strong>PODERES:</strong> por este instrumento particular, o(a) OUTORGANTE nomeia e constitui o(a) OUTORGADO(A) seu(sua) bastante procurador(a), conferindo-lhe os poderes da cláusula <em>ad judicia et extra</em> para o foro em geral, para representá-lo(a) em qualquer juízo, instância ou tribunal, podendo propor as ações competentes, defendê-lo(a) nas contrárias, apresentar defesas, recursos e manifestações, requerer, acordar em audiências, acompanhar processos administrativos e judiciais até decisão final, e substabelecer, com ou sem reserva de poderes.</p>
${especiais}
<p><strong>FINALIDADE:</strong> especialmente para ${v(d.objeto, "finalidade do mandato")}${area}.</p>
${rodapeAssinaturas(d, [{ nome: v(d.cliente_nome, "outorgante"), papel: "OUTORGANTE" }], false)}`;
}

/** Grava a qualificação digitada no gerador no cadastro do cliente (opt-in do usuário). */
export async function salvarQualificacaoNoCadastro(fichaId: string, d: DadosDocumento): Promise<void> {
  const pj = d.cliente_tipo === "pj";
  await salvarCadastro(fichaId, {
    tipo_pessoa: d.cliente_tipo,
    nome: d.cliente_nome,
    documento: soDigitos(d.cliente_cpf) || null,
    rg: pj ? null : d.cliente_rg,
    nacionalidade: pj ? null : d.cliente_nacionalidade,
    estado_civil: pj ? null : d.cliente_estado_civil,
    profissao: pj ? null : d.cliente_profissao,
    endereco: d.cliente_endereco,
    email: null,
    representante_nome: pj ? d.representante_nome : null,
    representante_cpf: pj ? soDigitos(d.representante_cpf) || null : null,
  });
}

/** Copia o documento formatado (HTML + texto) para colar no Word/Google Docs ou na assinatura eletrônica. */
export async function copiarFormatado(html: string): Promise<void> {
  const completo = `<div style="font-family:'Times New Roman',serif;font-size:12pt;line-height:1.5">${html}</div>`;
  // Texto puro com quebras de parágrafo (o elemento fora da página não tem layout para innerText).
  const decodificador = document.createElement("textarea");
  decodificador.innerHTML = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h1|h2|div)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  const texto = decodificador.value.replace(/\n{3,}/g, "\n\n").trim();
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([completo], { type: "text/html" }),
        "text/plain": new Blob([texto], { type: "text/plain" }),
      }),
    ]);
    return;
  }
  await navigator.clipboard.writeText(texto);
}

export function gerarDocumentoHtml(modelo: ModeloDocumento, dados: DadosDocumento): string {
  return modelo === "contrato_honorarios" ? contratoHonorarios(dados) : procuracao(dados);
}

/** Estilos compartilhados entre a pré-visualização (escopo .doc-juridico) e a impressão. */
export const CSS_DOCUMENTO = `
.doc-juridico { font-family: "Times New Roman", Times, serif; font-size: 12pt; line-height: 1.5; color: #111; }
.doc-juridico h1 { font-size: 14pt; text-align: center; text-transform: uppercase; margin: 0 0 18pt; font-weight: bold; }
.doc-juridico h2 { font-size: 12pt; margin: 14pt 0 6pt; font-weight: bold; }
.doc-juridico p { text-align: justify; margin: 0 0 9pt; }
.doc-juridico .vazio { background: #fef3c7; color: #92400e; padding: 0 2px; border-radius: 2px; }
.doc-juridico .local-data { text-align: right; margin-top: 18pt; }
.doc-juridico .assinatura { margin: 36pt auto 0; width: 70%; text-align: center; break-inside: avoid; }
.doc-juridico .assinatura .linha { border-top: 1px solid #111; margin-bottom: 4pt; }
.doc-juridico .assinatura p { text-align: center; margin: 0; }
.doc-juridico .testemunhas { margin-top: 24pt; break-inside: avoid; }
`;

/** Imprime (ou salva como PDF) apenas o documento, num iframe isolado. */
export function imprimirDocumento(html: string, titulo: string) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc || !iframe.contentWindow) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(titulo)}</title>
<style>@page { size: A4; margin: 2.5cm 2cm; } body { margin: 0; } ${CSS_DOCUMENTO}
@media print { .doc-juridico .vazio { background: none; color: #111; } }</style></head>
<body><div class="doc-juridico">${html}</div></body></html>`);
  doc.close();
  const janela = iframe.contentWindow;
  const limpar = () => setTimeout(() => iframe.remove(), 500);
  janela.addEventListener("afterprint", limpar, { once: true });
  setTimeout(() => {
    janela.focus();
    janela.print();
    setTimeout(limpar, 60_000); // garantia caso afterprint não dispare
  }, 150);
}
