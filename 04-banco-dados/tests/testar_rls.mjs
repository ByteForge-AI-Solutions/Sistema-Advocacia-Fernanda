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
