// Testes de invasão do RLS num Postgres real (PGlite), simulando o PostgREST:
// SET ROLE authenticated/anon + request.jwt.claims com o e-mail de cada usuário.
// Dados 100% fictícios (CPF/CNPJ de exemplo de documentação).
// Uso: cd 04-banco-dados/tests && npm ci && npm test
import path from "node:path";
import { fileURLToPath } from "node:url";
import { montarBanco } from "./aplicar.mjs";

const raizRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const db = await montarBanco(raizRepo);
let falhas = 0;
let total = 0;
const ok = (cond, desc) => {
  total++;
  if (cond) console.log("  ok  ", desc);
  else {
    falhas++;
    console.log("  FALHA", desc);
  }
};

// ---------- dados (como dono do banco, sem RLS) ----------
const email = { fernanda: "fernanda@teste.local", kayo: "kayo@teste.local", caio: "caio@teste.local",
  karolina: "karolina@teste.local", guilherme: "guilherme@teste.local", ana: "ana@teste.local", dev: "dev@teste.local" };
await db.exec(`
  UPDATE advogados SET email = CASE
    WHEN nome LIKE 'Fernanda%' THEN '${email.fernanda}' WHEN nome LIKE 'Kayo%' THEN '${email.kayo}'
    WHEN nome LIKE 'Caio%' THEN '${email.caio}' WHEN nome LIKE 'Karolina%' THEN '${email.karolina}'
    WHEN nome LIKE 'Guilherme%' THEN '${email.guilherme}' WHEN nome LIKE 'Ana%' THEN '${email.ana}' END;
  UPDATE advogados SET cargo = 'socio' WHERE nome LIKE 'Fernanda%';
  INSERT INTO advogados (nome, email, cargo, areas_atuacao, ativo) VALUES ('Dev Teste', '${email.dev}', 'desenvolvedor', '{}', true);
`);
const id = async (sql) => (await db.query(sql)).rows[0]?.id;
const adv = {};
for (const k of Object.keys(email)) adv[k] = await id(`SELECT id FROM advogados WHERE email = '${email[k]}'`);

const novaFicha = async (nome, area, resp) =>
  id(`INSERT INTO fichas_clientes (nome_cliente, telefone, area_identificada, prioridade, resumo_fatos, advogado_id)
      VALUES ('${nome}', '5566900000000', '${area}', 'media', 'Relato fictício.', ${resp ? `'${resp}'` : "NULL"}) RETURNING id`);
const f = {
  caio: await novaFicha("Cliente Caio", "tributario", adv.caio),
  karol: await novaFicha("Cliente Karolina", "trabalhista", adv.karolina),
  ana: await novaFicha("Cliente Ana", "trabalhista", adv.ana),
  dev: await novaFicha("Cliente Dev", "civil", adv.dev),
  sem: await novaFicha("Cliente Sem Resp", "trabalhista", null),
  kayo: await novaFicha("Cliente Kayo", "civil", adv.kayo),
};
await db.exec(`
  INSERT INTO clientes_cadastro (ficha_id, tipo_pessoa, nome, documento) VALUES
    ('${f.caio}', 'pf', 'Cliente Caio', '52998224725'), ('${f.karol}', 'pj', 'Empresa Karol', '11222333000181');
`);
const contrato = async (ficha, resp) =>
  id(`INSERT INTO fin_contratos (ficha_id, advogado_id, tipo, descricao, valor_total) VALUES ('${ficha}', '${resp}', 'honorarios', 'Honorários', 3000) RETURNING id`);
const c = { caio: await contrato(f.caio, adv.caio), ana: await contrato(f.ana, adv.ana), karol: await contrato(f.karol, adv.karolina) };
await db.exec(`
  INSERT INTO fin_parcelas (contrato_id, numero, valor, vencimento) VALUES
    ('${c.caio}', 1, 3000, '2026-12-10'), ('${c.ana}', 1, 1500, '2026-12-10'), ('${c.ana}', 2, 1500, '2027-01-10'),
    ('${c.karol}', 1, 3000, '2026-12-10');
  INSERT INTO fichas_documentos (ficha_id, categoria, nome, caminho, tamanho_bytes, tipo_mime, enviado_por) VALUES
    ('${f.caio}', 'procuracao', 'Procuração', '${f.caio}/0f5c2d8e-1a2b-4c3d-8e9f-0a1b2c3d4e5f.pdf', 1000, 'application/pdf', '${adv.caio}'),
    ('${f.ana}', 'comprovante', 'Comprovante', '${f.ana}/1f5c2d8e-1a2b-4c3d-8e9f-0a1b2c3d4e5f.pdf', 1000, 'application/pdf', '${adv.ana}');
  INSERT INTO storage.objects (bucket_id, name) VALUES
    ('documentos-clientes', '${f.caio}/0f5c2d8e-1a2b-4c3d-8e9f-0a1b2c3d4e5f.pdf'),
    ('documentos-clientes', '${f.karol}/2f5c2d8e-1a2b-4c3d-8e9f-0a1b2c3d4e5f.pdf');
`);

// ---------- simulação do PostgREST ----------
async function como(quem, sql, params = []) {
  const claims = quem === "anon" ? "{}" : JSON.stringify({ email: email[quem], role: "authenticated" });
  try {
    return await db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL ROLE ${quem === "anon" ? "anon" : "authenticated"}`);
      await tx.query("SELECT set_config('request.jwt.claims', $1, true)", [claims]);
      const r = await tx.query(sql, params);
      return { rows: r.rows, afetadas: r.affectedRows ?? r.rows.length, erro: null };
    });
  } catch (e) {
    return { rows: [], afetadas: 0, erro: e.message };
  }
}
const ids = (r) => new Set(r.rows.map((x) => x.id));
const iguais = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

console.log("\n1. Isolamento de fichas (quem vê o quê)");
const esperado = {
  caio: [f.caio], karolina: [f.karol, f.sem], ana: [f.ana], dev: [f.dev],
  fernanda: [f.caio, f.karol, f.ana, f.sem, f.kayo], kayo: [f.kayo],
};
for (const [quem, lista] of Object.entries(esperado)) {
  const r = await como(quem, "SELECT id FROM fichas_clientes");
  ok(iguais(ids(r), new Set(lista)), `${quem} vê exatamente ${lista.length} ficha(s)${r.erro ? " — " + r.erro : ""}`);
}

console.log("\n2. IDOR: advogado comum tentando dados de outro advogado pela API");
ok((await como("caio", "SELECT * FROM clientes_cadastro WHERE ficha_id = $1", [f.karol])).rows.length === 0, "Caio não lê CPF/CNPJ (cadastro) da ficha da Karolina");
ok((await como("caio", "SELECT documento FROM clientes_cadastro")).rows.length === 1, "Caio lê só o cadastro da própria ficha");
ok(iguais(ids(await como("caio", "SELECT id FROM fin_contratos")), new Set([c.caio])), "Caio vê só o próprio contrato");
ok((await como("caio", "SELECT p.* FROM fin_parcelas p JOIN fin_contratos c ON c.id = p.contrato_id WHERE c.ficha_id = $1", [f.karol])).rows.length === 0, "Caio não lê parcelas da Karolina");
ok((await como("caio", "UPDATE fichas_clientes SET proxima_acao = 'x', proxima_acao_em = now() WHERE id = $1", [f.karol])).afetadas === 0, "Caio não altera ficha da Karolina (0 linhas)");
ok((await como("caio", "INSERT INTO fin_contratos (ficha_id, advogado_id, tipo, descricao, valor_total) VALUES ($1, $2, 'honorarios', 'x', 10)", [f.karol, adv.caio])).erro !== null, "Caio não cria contrato na ficha da Karolina");
ok((await como("caio", "INSERT INTO clientes_cadastro (ficha_id, nome) VALUES ($1, 'x')", [f.kayo])).erro !== null, "Caio não grava cadastro na ficha do Kayo");
ok((await como("caio", "INSERT INTO fichas_documentos (ficha_id, categoria, nome, caminho, tamanho_bytes, tipo_mime, enviado_por) VALUES ($1, 'outro', 'x', $1 || '/3f5c2d8e-1a2b-4c3d-8e9f-0a1b2c3d4e5f.pdf', 10, 'application/pdf', $2)", [f.karol, adv.caio])).erro !== null, "Caio não registra documento na ficha da Karolina");
ok((await como("caio", "SELECT name FROM storage.objects WHERE name LIKE $1", [f.karol + "/%"])).rows.length === 0, "Caio não enxerga arquivo da Karolina no Storage");
ok((await como("caio", "SELECT name FROM storage.objects")).rows.length === 1, "Caio enxerga só o arquivo da própria ficha");
ok((await como("caio", "SELECT crm_ficha_assumir($1)", [f.sem])).erro !== null, "Caio não assume ficha sem responsável de outra área");
ok((await como("caio", "UPDATE fin_parcelas SET pago_em = current_date, valor_pago = 1, meio = 'pix' WHERE contrato_id = $1", [c.karol])).afetadas === 0, "Caio não registra pagamento em contrato da Karolina");

console.log("\n3. Atribuição em massa em fichas_clientes (colunas do bot/auditoria)");
for (const col of ["resumo_fatos = 'forjado'", "telefone = '5500000000000'", "cpf = '52998224725'", "created_at = now() - interval '1 year'", "temperatura = 'urgente'", "etapa_desde = now()"]) {
  const r = await como("caio", `UPDATE fichas_clientes SET ${col} WHERE id = $1`, [f.caio]);
  ok(r.erro !== null && /permission denied/i.test(r.erro), `Caio não altera ${col.split(" ")[0]} da própria ficha`);
}
const legit = await como("caio", "UPDATE fichas_clientes SET proxima_acao = 'Ligar', proxima_acao_em = now() + interval '1 day', faixa_divida = 'acima_500k' WHERE id = $1 RETURNING id", [f.caio]);
ok(legit.erro === null && legit.rows.length === 1, `Caio edita campos de lead da própria ficha${legit.erro ? " — " + legit.erro : ""}`);

console.log("\n4. Estagiária: financeiro e exclusões");
const pAna = (await db.query(`SELECT id FROM fin_parcelas WHERE contrato_id = '${c.ana}' AND numero = 1`)).rows[0].id;
const pAna2 = (await db.query(`SELECT id FROM fin_parcelas WHERE contrato_id = '${c.ana}' AND numero = 2`)).rows[0].id;
ok((await como("ana", "DELETE FROM fin_parcelas WHERE id = $1", [pAna])).afetadas === 0, "Ana não exclui parcela");
ok((await como("ana", "DELETE FROM fin_contratos WHERE id = $1", [c.ana])).afetadas === 0, "Ana não exclui contrato");
ok((await como("ana", "DELETE FROM fichas_documentos WHERE ficha_id = $1", [f.ana])).afetadas === 0, "Ana não exclui documento");
ok((await como("ana", "DELETE FROM fichas_clientes WHERE id = $1", [f.ana])).afetadas === 0, "Ana não exclui ficha");
ok((await como("ana", "UPDATE fin_parcelas SET valor = 1 WHERE id = $1", [pAna2])).erro !== null, "Ana não altera valor de parcela");
ok((await como("ana", "UPDATE fin_contratos SET cancelado = true WHERE id = $1", [c.ana])).erro !== null, "Ana não cancela contrato");
ok((await como("ana", "UPDATE fin_contratos SET valor_total = 1 WHERE id = $1", [c.ana])).erro !== null, "Ana não altera valor do contrato");
const pag = await como("ana", "UPDATE fin_parcelas SET pago_em = current_date, valor_pago = 1500, meio = 'pix' WHERE id = $1 RETURNING registrado_por", [pAna]);
ok(pag.erro === null && pag.rows[0]?.registrado_por === adv.ana, `Ana registra pagamento (autoria gravada)${pag.erro ? " — " + pag.erro : ""}`);
ok((await como("ana", "UPDATE fin_parcelas SET pago_em = NULL, valor_pago = NULL, meio = NULL WHERE id = $1", [pAna])).erro !== null, "Ana não desfaz pagamento");
ok((await como("fernanda", "UPDATE fin_parcelas SET pago_em = NULL, valor_pago = NULL, meio = NULL WHERE id = $1 RETURNING id", [pAna])).rows.length === 1, "Fernanda (sócia, supervisora) desfaz pagamento");
ok((await como("ana", "UPDATE fin_parcelas SET contrato_id = $2 WHERE id = $1", [pAna2, c.caio])).erro !== null, "Ninguém move parcela para outro contrato");

console.log("\n5. Conta de desenvolvedor isolada (nos dois sentidos)");
const advDev = await como("dev", "SELECT id FROM advogados");
ok(advDev.rows.length === 1 && advDev.rows[0].id === adv.dev, "Dev vê só a própria linha em advogados");
ok(!ids(await como("fernanda", "SELECT id FROM advogados")).has(adv.dev), "Sócia não vê a conta de desenvolvedor");
ok((await como("dev", "SELECT id FROM fin_contratos")).rows.length === 0, "Dev não vê contratos reais");
ok((await como("dev", "SELECT id FROM clientes_cadastro")).rows.length === 0, "Dev não vê cadastros reais");
ok((await como("dev", "SELECT name FROM storage.objects")).rows.length === 0, "Dev não vê arquivos reais");
ok(!ids(await como("fernanda", "SELECT id FROM fichas_clientes")).has(f.dev), "Sócia não vê ficha de teste do dev");

console.log("\n6. Transferência de ficha leva o financeiro junto (falha F1 corrigida)");
await db.exec(`UPDATE fichas_clientes SET advogado_id = '${adv.karolina}' WHERE id = '${f.caio}'`);
ok((await como("caio", "SELECT id FROM fin_contratos")).rows.length === 0, "Caio perde acesso ao contrato depois da transferência");
ok(ids(await como("karolina", "SELECT id FROM fin_contratos")).has(c.caio), "Karolina passa a ver o contrato transferido");
ok((await db.query(`SELECT advogado_id FROM fin_contratos WHERE id = '${c.caio}'`)).rows[0].advogado_id === adv.karolina, "advogado_id do contrato acompanhou a ficha");
ok((await como("caio", "SELECT * FROM clientes_cadastro")).rows.length === 0, "Caio perde acesso ao cadastro (CPF) transferido");
await db.exec(`UPDATE fichas_clientes SET advogado_id = '${adv.caio}' WHERE id = '${f.caio}'`);

console.log("\n7. Storage: nomes anônimos e bucket privado");
const nomeOk = `${f.caio}/4f5c2d8e-1a2b-4c3d-8e9f-0a1b2c3d4e5f.pdf`;
ok((await como("caio", "INSERT INTO storage.objects (bucket_id, name) VALUES ('documentos-clientes', $1)", [nomeOk])).erro === null, "Upload com caminho UUID/UUID.pdf é aceito");
for (const ruim of [`${f.caio}/Joao_Silva_CPF_52998224725.pdf`, `${f.caio}/4f5c2d8e-1a2b-4c3d-8e9f-0a1b2c3d4e5f.html`, `${f.caio}/4f5c2d8e-1a2b-4c3d-8e9f-0a1b2c3d4e5f.svg`, `${f.karol}/5f5c2d8e-1a2b-4c3d-8e9f-0a1b2c3d4e5f.pdf`]) {
  ok((await como("caio", "INSERT INTO storage.objects (bucket_id, name) VALUES ('documentos-clientes', $1)", [ruim])).erro !== null, `Upload recusado: ${ruim.split("/")[1]}${ruim.startsWith(f.karol) ? " (ficha alheia)" : ""}`);
}
const bucket = (await db.query("SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'documentos-clientes'")).rows[0];
ok(bucket.public === false && Number(bucket.file_size_limit) === 20971520, "Bucket privado, limite de 20 MB");
const perigosos = ["text/html", "application/xhtml+xml", "image/svg+xml", "text/javascript", "application/javascript",
  "application/octet-stream", "application/x-msdownload", "text/xml", "application/xml"];
ok(!bucket.allowed_mime_types.some((t) => perigosos.includes(t)) && bucket.allowed_mime_types.length === 6, "Bucket só com os 6 tipos permitidos (sem HTML/SVG/JS/executável)");

console.log("\n8. Chave anon (pública) e RPCs restritas");
ok(/permission denied/i.test((await como("anon", "SELECT * FROM fichas_clientes")).erro ?? ""), "anon: sem acesso a fichas");
ok(/permission denied/i.test((await como("anon", "SELECT * FROM advogados")).erro ?? ""), "anon: sem acesso a advogados");
ok(/permission denied/i.test((await como("anon", "SELECT * FROM clientes_cadastro")).erro ?? ""), "anon: sem acesso a cadastros");
ok(/permission denied/i.test((await como("anon", "SELECT crm_indicadores(now() - interval '1 day', now())")).erro ?? ""), "anon: não executa crm_indicadores");
ok(/permission denied/i.test((await como("caio", "SELECT dfu_receber('5566900000000','x','oi','text','x')")).erro ?? ""), "authenticated: não executa RPC do bot (dfu_receber)");
ok(/permission denied/i.test((await como("caio", "SELECT crm_google_concluir(1, true, null, null, null)")).erro ?? ""), "authenticated: não executa RPC do worker Google");

console.log("\n8b. Gatilhos SECURITY DEFINER sem EXECUTE continuam rodando (v10)");
const reuniao = await como("caio", "INSERT INTO agenda_advogados (advogado_id, titulo_evento, area_juridica, data_hora_inicio, data_hora_fim) VALUES ($1, 'Reunião teste', 'tributario', now() + interval '3 days', now() + interval '3 days 1 hour') RETURNING id", [adv.caio]);
ok(reuniao.erro === null && reuniao.rows.length === 1, `Caio cria reunião (dfu_proteger_agenda e crm_agenda_enfileirar_google disparam)${reuniao.erro ? " — " + reuniao.erro : ""}`);
const cKayo = await id(`INSERT INTO fin_contratos (ficha_id, advogado_id, tipo, descricao, valor_total) VALUES ('${f.kayo}', '${adv.kayo}', 'honorarios', 'Honorários', 1000) RETURNING id`);
const transf = await como("fernanda", "UPDATE fichas_clientes SET advogado_id = $2, proxima_acao = 'Assumir caso', proxima_acao_em = now() + interval '1 day' WHERE id = $1 RETURNING id", [f.kayo, adv.caio]);
ok(transf.erro === null && transf.rows.length === 1, `Sócia transfere ficha pela tela (crm_fin_acompanhar_ficha dispara)${transf.erro ? " — " + transf.erro : ""}`);
ok((await db.query(`SELECT advogado_id FROM fin_contratos WHERE id = '${cKayo}'`)).rows[0].advogado_id === adv.caio, "Contrato acompanha a ficha transferida pela sócia");
await db.exec(`UPDATE fichas_clientes SET advogado_id = '${adv.kayo}' WHERE id = '${f.kayo}'`);
for (const fn of ["crm_agenda_enfileirar_google", "crm_fin_acompanhar_ficha", "crm_fin_avancar_funil", "crm_fin_contrato_guarda", "dfu_proteger_agenda"]) {
  ok(/permission denied/i.test((await como("caio", `SELECT public.${fn}()`)).erro ?? ""), `authenticated não executa ${fn} pela API`);
}

console.log("\n8c. Prospecção de execuções fiscais (v11): só sócio e advogado; escrita só da service_role");
// Dados fictícios: CNPJ de exemplo de documentação e números CNJ inventados.
await db.exec(`
  INSERT INTO prosp_processos (numero_cnj, tribunal, data_distribuicao, polo_ativo, polo_ativo_fazenda, executado_nome, cnpj, situacao)
    VALUES ('50012345520264036182', 'TRF3', '2026-11-10', 'UNIAO FEDERAL - FAZENDA NACIONAL', true, 'EMPRESA EXEMPLO LTDA', '11222333000181', 'qualificado'),
           ('50000010020264047000', 'TRF4', '2026-11-11', 'CONSELHO REGIONAL', false, NULL, '11444777000161', 'fora_do_filtro');
  INSERT INTO prosp_cnpj_cache (cnpj, razao_social, natureza_juridica, uf, telefones, email, fonte)
    VALUES ('11222333000181', 'EMPRESA EXEMPLO LTDA', '2062', 'SP', '{"(11) 3456-7890"}', 'contato@exemplo.com.br', 'minhareceita');
  INSERT INTO prosp_pgfn_devedores (cnpj, nome, uf, valor_ajuizado, valor_nao_ajuizado, qtd_inscricoes, base_referencia) VALUES
    ('11222333000181', 'EMPRESA EXEMPLO LTDA', 'SP', 450000, 0, 3, '2026T3'),
    ('11444777000161', 'OUTRA EMPRESA SA', 'PR', 50000, 20000, 1, '2026T3'),
    ('12345678000195', 'TERCEIRA EMPRESA LTDA', 'RS', 0, 900000, 2, '2026T3'),
    ('34028316000103', 'EMPRESA DE MG LTDA', 'MG', 0, 900000, 2, '2026T3'),
    ('45997418000153', 'FULANO DE TAL 52998224725', 'SP', 0, 300000, 1, '2026T3'),
    ('19131243000197', 'EMPRESA INEXISTENTE LTDA', 'SC', 0, 200000, 1, '2026T3'),
    ('27865757000102', 'EMPRESA INDIVIDUAL SEM NOME', 'BA', 0, 300000, 1, '2026T3');
  INSERT INTO prosp_cnpj_cache (cnpj, encontrado, fonte) VALUES ('19131243000197', false, 'minhareceita');
  INSERT INTO prosp_cnpj_cache (cnpj, natureza_juridica, fonte) VALUES ('27865757000102', '2135', 'brasilapi');
`);
const oportunidades = async (quem) => como(quem, "SELECT origem, cnpj, valor_causa, valor_fonte, tribunal, cadastro_verificado FROM prosp_oportunidades ORDER BY valor_causa DESC");
const opSocia = await oportunidades("fernanda");
ok(opSocia.erro === null && opSocia.rows.length === 2, `Sócia vê 2 oportunidades (Fazenda, CNPJ, > R$ 100 mil, TRF1/3/4, sem MEI/duplicata)${opSocia.erro ? " — " + opSocia.erro : opSocia.rows.length !== 2 ? ` — veio ${opSocia.rows.length}` : ""}`);
ok(opSocia.rows[0]?.valor_causa > opSocia.rows[1]?.valor_causa, "Lista ordenável do maior valor para o menor");
const doProcesso = opSocia.rows.find((r) => r.origem === "processo");
ok(doProcesso?.valor_fonte === "pgfn" && Number(doProcesso?.valor_causa) === 450000, "Processo sem valor publicado usa o total ajuizado na PGFN (valor_fonte = pgfn)");
ok(!opSocia.rows.some((r) => r.cnpj === "11444777000161"), "Fora da lista: polo ativo não é a Fazenda e dívida abaixo de R$ 100 mil");
ok(!opSocia.rows.some((r) => r.cnpj === "34028316000103"), "Fora da lista: UF fora do TRF1/TRF3/TRF4 (MG é TRF6)");
ok(!opSocia.rows.some((r) => r.cnpj === "45997418000153"), "Fora da lista: MEI (CPF na razão social), mesmo antes de consultar a Receita");
ok(!opSocia.rows.some((r) => r.cnpj === "27865757000102"), "Fora da lista: natureza 2135 (empresário individual) vinda da base CNPJ");
ok(!opSocia.rows.some((r) => r.cnpj === "19131243000197"), "Fora da lista: CNPJ que a Receita não encontrou");
ok(opSocia.rows.filter((r) => r.cnpj === "11222333000181").length === 1 && doProcesso?.cnpj === "11222333000181",
  "Sem duplicata: CNPJ com processo não aparece de novo como linha da PGFN");
ok(doProcesso?.cadastro_verificado === true && opSocia.rows.find((r) => r.origem === "pgfn")?.cadastro_verificado === false,
  "cadastro_verificado indica o que já passou pela base da Receita");
ok((await oportunidades("caio")).rows.length === 2, "Advogado titular vê a prospecção");
for (const quem of ["ana", "dev"]) {
  ok((await oportunidades(quem)).rows.length === 0, `${quem === "ana" ? "Estagiária" : "Desenvolvedor"} não vê oportunidades (view com security_invoker)`);
  ok((await como(quem, "SELECT * FROM prosp_cnpj_cache")).rows.length === 0, `${quem === "ana" ? "Estagiária" : "Desenvolvedor"} não lê telefone/e-mail do cache de CNPJ`);
}
ok(/permission denied/i.test((await como("anon", "SELECT * FROM prosp_oportunidades")).erro ?? ""), "anon: sem acesso à view de oportunidades");
ok(/permission denied/i.test((await como("anon", "SELECT * FROM prosp_processos")).erro ?? ""), "anon: sem acesso a prosp_processos");
for (const [sql, desc] of [
  ["INSERT INTO prosp_processos (numero_cnj, tribunal) VALUES ('50099995520264036182', 'TRF3')", "criar processo"],
  ["UPDATE prosp_processos SET cnpj = '12345678000195'", "alterar processo"],
  ["DELETE FROM prosp_processos", "excluir processo"],
  ["UPDATE prosp_cnpj_cache SET email = 'x@y.com'", "alterar contato do cache"],
  ["INSERT INTO prosp_pgfn_devedores (cnpj, nome, base_referencia) VALUES ('12345678000195', 'x', '2026T3')", "gravar na base PGFN"],
  ["UPDATE prosp_auditoria SET qtd_registros = 0", "alterar auditoria"],
  ["DELETE FROM prosp_auditoria", "apagar auditoria"],
]) {
  ok(/permission denied/i.test((await como("fernanda", sql)).erro ?? ""), `Sócia não consegue ${desc} pela API (só a service_role)`);
}
ok(/permission denied/i.test((await como("caio", "SELECT prosp_cnpjs_para_enriquecer(10)")).erro ?? ""), "authenticated não executa a fila interna de enriquecimento");
const seqPriv = (await db.query(`SELECT has_sequence_privilege('anon', 'public.prosp_auditoria_id_seq', 'USAGE,SELECT,UPDATE') AS anon,
  has_sequence_privilege('authenticated', 'public.prosp_auditoria_id_seq', 'USAGE,SELECT,UPDATE') AS auth`)).rows[0];
ok(!seqPriv.anon && !seqPriv.auth, "Sequência da auditoria sem privilégio para anon/authenticated (auditoria 24/11)");
ok(/permission denied/i.test((await como("caio", "SELECT nextval('public.prosp_auditoria_id_seq')")).erro ?? ""), "Advogado não mexe na sequência da auditoria");
const exp = await como("caio", "INSERT INTO prosp_auditoria (acao, parametros, qtd_registros) VALUES ('exportacao', '{\"tribunais\":[\"TRF3\"]}', 3) RETURNING advogado_id");
ok(exp.erro === null && exp.rows[0]?.advogado_id === adv.caio, `Advogado registra a própria exportação (autoria pelo JWT)${exp.erro ? " — " + exp.erro : ""}`);
ok((await como("caio", "INSERT INTO prosp_auditoria (advogado_id, acao, qtd_registros) VALUES ($1, 'exportacao', 1)", [adv.kayo])).erro !== null, "Advogado não forja exportação em nome de outro");
ok((await como("caio", `INSERT INTO prosp_auditoria (acao, parametros, qtd_registros) VALUES ('exportacao', '{"obs":"52998224725"}', 1)`)).erro !== null,
  "Auditoria não aceita chave livre em parametros (sem texto livre/dado pessoal no log)");
const expCompleta = await como("caio", `INSERT INTO prosp_auditoria (acao, parametros, qtd_registros) VALUES ('exportacao',
  '{"tribunais":["TRF1"],"origem":"todas","de":null,"ate":null,"valor_minimo":100000,"com_busca":false}', 2) RETURNING id`);
ok(expCompleta.erro === null, `Exportação com os parâmetros reais do CRM é aceita${expCompleta.erro ? " — " + expCompleta.erro : ""}`);
ok((await como("caio", "INSERT INTO prosp_auditoria (acao, qtd_registros) VALUES ('busca', 1)")).erro !== null, "Advogado não forja registro de busca (só a Edge)");
ok((await como("ana", "INSERT INTO prosp_auditoria (acao, qtd_registros) VALUES ('exportacao', 1)")).erro !== null, "Estagiária não registra exportação");
ok((await como("kayo", "SELECT id FROM prosp_auditoria")).rows.length === 0 && (await como("fernanda", "SELECT id FROM prosp_auditoria")).rows.length === 2,
  "Auditoria: sócia vê todas; outro advogado não vê a exportação do colega");
const svc = await db.transaction(async (tx) => {
  await tx.exec("SET LOCAL ROLE service_role");
  await tx.exec("UPDATE prosp_processos SET situacao = 'qualificado' WHERE numero_cnj = '50000010020264047000'");
  return (await tx.query("SELECT cnpj FROM prosp_cnpjs_para_enriquecer(10)")).rows.map((r) => r.cnpj);
});
ok(svc.includes("12345678000195") && !svc.includes("11222333000181") && !svc.includes("19131243000197"),
  "service_role: fila de enriquecimento traz só CNPJ sem cache (nem o não encontrado, que fica 30 dias em cache)");
ok(!svc.includes("45997418000153"), "service_role: MEI (CPF no nome) nem entra na fila de consulta de contato");
// Reserva da fila (o que a Edge faz pelo PostgREST): só uma chamada fica com cada processo.
const reservar = () => db.transaction(async (tx) => {
  await tx.exec("SET LOCAL ROLE service_role");
  return (await tx.query(`UPDATE prosp_processos SET proxima_tentativa_em = now() + interval '3 minutes'
    WHERE numero_cnj = '50000010020264047000' AND proxima_tentativa_em <= now() RETURNING id`)).rows.length;
});
ok((await reservar()) === 1 && (await reservar()) === 0, "Fila: processo reservado por uma execução não é pego por outra simultânea");
const carimbo = (await db.query("SELECT created_at < updated_at AS ok FROM prosp_processos WHERE numero_cnj = '50000010020264047000'")).rows[0];
ok(carimbo?.ok === true, "service_role grava na fila e o gatilho de carimbo (SECURITY INVOKER) roda");

console.log("\n8d. Compatibilidade com o bot DFU V2 depois da v11");
const RPCS_BOT = ["dfu_receber(text,text,text,text,text)", "dfu_contexto(text)", "dfu_recuperar_pendentes(integer)",
  "dfu_aplicar_ia(text,text,jsonb)", "dfu_retirar_saida(text,integer)", "dfu_marcar_saida(uuid,text,text)",
  "dfu_verificar_saida(uuid)", "dfu_gerar_followups(boolean)", "dfu_ofertar(text)", "dfu_criar_ficha(text)", "dfu_confirmar(text,integer)"];
const privRpc = (await db.query(`SELECT f, has_function_privilege('service_role', ('public.' || f)::regprocedure, 'EXECUTE') AS svc,
    has_function_privilege('authenticated', ('public.' || f)::regprocedure, 'EXECUTE') AS auth,
    has_function_privilege('anon', ('public.' || f)::regprocedure, 'EXECUTE') AS anon
  FROM unnest($1::text[]) f`, [RPCS_BOT])).rows;
ok(privRpc.length === RPCS_BOT.length && privRpc.every((r) => r.svc && !r.auth && !r.anon),
  `RPCs do bot: só a service_role (n8n) executa (${privRpc.filter((r) => !r.svc || r.auth || r.anon).map((r) => r.f).join(", ") || "ok"})`);
const TABELAS_BOT = ["conversas_memoria", "dfu_erros", "dfu_origens", "dfu_revisoes", "agenda_google_fila", "agenda_google_notificacoes"];
const tabBot = (await db.query(`SELECT c.relname, c.relrowsecurity AS rls,
    (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)::int AS politicas,
    has_table_privilege('anon', c.oid, 'SELECT') OR has_table_privilege('authenticated', c.oid, 'SELECT') AS publico,
    has_table_privilege('service_role', c.oid, 'SELECT') AS svc
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ANY($1)`, [TABELAS_BOT])).rows;
ok(tabBot.length === TABELAS_BOT.length && tabBot.every((r) => r.rls && r.politicas === 0 && !r.publico && r.svc),
  "Tabelas internas do bot: RLS sem política (nega tudo), sem privilégio para anon/authenticated, service_role mantém acesso");
const objetosV11NoBot = (await db.query(`SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND (proname LIKE 'dfu\_%' AND prosrc ILIKE '%prosp\_%' OR proname LIKE 'prosp\_%' AND prosrc ILIKE '%dfu\_%')`)).rows;
ok(objetosV11NoBot.length === 0, "Bot e prospecção não dependem um do outro (nenhuma função cruza dfu_* e prosp_*)");
// Fluxo real do n8n como service_role, depois de todas as migrações (v11 inclusa).
const fluxo = await db.transaction(async (tx) => {
  await tx.exec("SET LOCAL ROLE service_role");
  const q = async (sql, params = []) => (await tx.query(sql, params)).rows[0];
  const tel = "5566999990000";
  const r1 = await q("SELECT dfu_receber($1, 'wamid.teste.1', 'Olá', 'texto', 'Cliente Teste') AS r", [tel]);
  const saida = await q("SELECT * FROM dfu_retirar_saida($1, 5)", [tel]);
  const verif = await q("SELECT dfu_verificar_saida($1) AS r", [saida.id]);
  const marcou = await q("SELECT dfu_marcar_saida($1, 'ENVIADO', 'wamid.saida.1') AS r", [saida.id]);
  const memoria = await q("SELECT count(*)::int AS n FROM conversas_memoria WHERE telefone_cliente = $1", [tel]);
  const r2 = await q("SELECT dfu_receber($1, 'wamid.teste.2', 'Recebi uma execução fiscal', 'texto', 'Cliente Teste') AS r", [tel]);
  const ctx = await q("SELECT dfu_contexto($1) AS r", [tel]);
  const ia = await q(`SELECT dfu_aplicar_ia($1, 'wamid.teste.2', '{"acao":"perguntar","area":"tributario","mensagem_ao_cliente":"Pode contar um pouco mais?"}'::jsonb) AS r`, [tel]);
  const pend = await q("SELECT count(*)::int AS n FROM dfu_recuperar_pendentes(5)");
  const fup = await q("SELECT dfu_gerar_followups(false) AS n");
  return { r1: r1.r, saida, verif: verif.r, marcou: marcou.r, memoria: memoria.n, r2: r2.r, ctx: ctx.r, ia: ia.r, pend: pend.n, fup: fup.n };
}).catch((e) => ({ erro: e.message }));
ok(!fluxo.erro, `Fluxo do n8n roda inteiro como service_role${fluxo.erro ? " — " + fluxo.erro : ""}`);
if (!fluxo.erro) {
  ok(fluxo.r1?.motivo === "primeira_mensagem" && fluxo.saida?.tipo === "intro", "dfu_receber grava a 1ª mensagem e enfileira a apresentação");
  ok(fluxo.verif?.permitir === true && fluxo.marcou === true && fluxo.memoria === 1, "dfu_retirar_saida → dfu_verificar_saida → dfu_marcar_saida gravam o envio e conversas_memoria");
  ok(fluxo.r2?.processar_ia === true && fluxo.ctx?.processar_ia === true, "dfu_receber libera a IA e dfu_contexto devolve o histórico");
  ok(fluxo.ia?.ok === true, `dfu_aplicar_ia aplica a resposta da IA${fluxo.ia?.ok === true ? "" : " — " + JSON.stringify(fluxo.ia)}`);
  ok(fluxo.pend === 0 && fluxo.fup === 0, "dfu_recuperar_pendentes e dfu_gerar_followups (desligado) rodam sem efeito colateral");
}

console.log("\n9. Catálogo do banco");
const semRls = (await db.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity")).rows;
ok(semRls.length === 0, `Todas as tabelas do public com RLS${semRls.length ? ": faltam " + semRls.map((r) => r.relname).join(", ") : ""}`);
const abertas = (await db.query("SELECT tablename, policyname FROM pg_policies WHERE schemaname IN ('public','storage') AND permissive = 'PERMISSIVE' AND (btrim(coalesce(qual,'')) = 'true' OR btrim(coalesce(with_check,'')) = 'true')")).rows;
ok(abertas.length === 0, `Nenhuma política USING (true)${abertas.length ? ": " + abertas.map((r) => r.tablename + "." + r.policyname).join(", ") : ""}`);
const semPath = (await db.query("SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) x WHERE x LIKE 'search_path=%')")).rows;
ok(semPath.length === 0, `Toda função SECURITY DEFINER fixa search_path${semPath.length ? ": faltam " + semPath.map((r) => r.proname).join(", ") : ""}`);
const anonExec = (await db.query("SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege('anon', p.oid, 'EXECUTE')")).rows;
ok(anonExec.length === 0, `Nenhuma função SECURITY DEFINER executável pela anon (Advisor 0028)${anonExec.length ? ": " + anonExec.map((r) => r.proname).join(", ") : ""}`);
const gatilhoAuth = (await db.query("SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef AND p.prorettype = 'trigger'::regtype AND has_function_privilege('authenticated', p.oid, 'EXECUTE')")).rows;
ok(gatilhoAuth.length === 0, `Nenhuma função de gatilho SECURITY DEFINER exposta a authenticated (Advisor 0029)${gatilhoAuth.length ? ": " + gatilhoAuth.map((r) => r.proname).join(", ") : ""}`);
// Advisor 0029 restante = só a lista conhecida de RPCs e funções de autorização usadas pelo RLS.
const PERMITIDAS = new Set(["pode_acessar_ficha", "advogado_atual_id", "crm_cargo_atual", "crm_pode_acessar_ficha_id", "crm_pode_excluir",
  "crm_pode_acessar_objeto", "crm_titular_da_area", "crm_pode_acessar_atendimento", "crm_atendimento_assumir", "crm_atendimento_responder",
  "crm_atendimento_transferir", "crm_atendimento_devolver_bot", "crm_atendimento_encerrar", "crm_atendimento_etiquetas", "crm_indicadores",
  "crm_indicadores_funil", "crm_ficha_assumir", "dfu_assumir_atendimento"]);
const authExec = (await db.query("SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE')")).rows.map((r) => r.proname);
const inesperadas = authExec.filter((n) => !PERMITIDAS.has(n));
ok(inesperadas.length === 0, `Funções SECURITY DEFINER para authenticated = só a lista aprovada (${authExec.length})${inesperadas.length ? ": inesperadas " + inesperadas.join(", ") : ""}`);

console.log(`\n${total - falhas}/${total} verificações de RLS passaram.`);
process.exit(falhas ? 1 : 0);
