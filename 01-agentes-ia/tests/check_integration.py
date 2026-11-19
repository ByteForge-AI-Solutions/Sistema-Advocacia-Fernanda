#!/usr/bin/env python3
"""Smoke tests ESTÁTICOS para bot v2.1; não acessa credenciais/rede.
Execute na raiz: python 01-agentes-ia/tests/check_integration.py
"""
from __future__ import annotations
import hashlib, json, pathlib, re, shutil, subprocess

ROOT=pathlib.Path(__file__).resolve().parents[2]
FLOW=ROOT/'01-agentes-ia/n8n/DFU_BOT_UNICO_CRM.json'
IMPORTER=ROOT/'01-agentes-ia/n8n/DFU_IMPORTADOR_CSV_OPCIONAL.json'
SQL=ROOT/'04-banco-dados/migrations/20261118_bot_unificado.sql'
EDGE=ROOT/'02-backend-integracao/supabase/functions/meta-webhook/index.ts'
CLI=ROOT/'03-crm-frontend'
js_count=0

for path in (FLOW,IMPORTER):
    wf=json.loads(path.read_text(encoding='utf-8'))
    nodes=wf['nodes']; names={n['name'] for n in nodes}
    assert len(names)==len(nodes), f'nomes duplicados em {path}'
    assert wf.get('active') is False, f'não entregar workflow ativo: {path}'
    assert all(n.get('id') and n.get('type') and n.get('position') for n in nodes)
    for src,ports in wf['connections'].items():
        assert src in names, f'origem não encontrada {src}'
        for destination in [e['node'] for edges in ports.values() for output in edges for e in output]:
            assert destination in names, f'alvo não encontrado {destination}'
    for n in nodes:
        if n['type']=='n8n-nodes-base.code':
            js_count+=1
            assert 'jsCode' in n['parameters']
            if shutil.which('node'):
                r=subprocess.run(['node','--input-type=module','--check','-'],input='async function __n8n_check__() {\n'+n['parameters']['jsCode']+'\n}\n',capture_output=True,text=True)
                assert r.returncode==0, f'JS inválido: {n["name"]}: {r.stderr[:300]}'

main=json.loads(FLOW.read_text(encoding='utf-8'))
ns={n['name']:n for n in main['nodes']}
assert len(ns)==27
assert all(name in ns for name in (
    '01 | Sinal interno da Edge (Meta persistida)',
    '04c | Contexto atualizado', '04d | Contexto disponível?',
    '15 | Portão de compliance e modo teste',
    '15a | Modo teste e compliance autorizados?',
    '15b | Revalidar opt-out no banco', '16 | Envio autorizado?',
    '21 | Recuperação de mensagens pendentes', '22 | Claim das pendências',
    '23 | Normalizar pendências'
))
con=main['connections']
def leads(a,b):
    return any(e['node']==b for edges in con[a].values() for output in edges for e in output)
assert leads('15 | Portão de compliance e modo teste','15a | Modo teste e compliance autorizados?')
assert leads('15a | Modo teste e compliance autorizados?','15b | Revalidar opt-out no banco')
assert leads('15a | Modo teste e compliance autorizados?','20 | Marcar envio bloqueado')
assert leads('15b | Revalidar opt-out no banco','16 | Envio autorizado?')
assert leads('04c | Contexto atualizado','04d | Contexto disponível?')
assert leads('21 | Recuperação de mensagens pendentes','22 | Claim das pendências')
assert leads('01 | Sinal interno da Edge (Meta persistida)','01b | Preparar sinal de atendimento')
assert 'COMPLIANCE_APROVADO' in ns['15 | Portão de compliance e modo teste']['parameters']['jsCode']
assert 'MODO_TESTE' in ns['15 | Portão de compliance e modo teste']['parameters']['jsCode']
assert ns['16 | Envio autorizado?']['parameters']['conditions']['conditions'][0]['leftValue']=='={{ $json.permitir === true }}'
assert 'dfu_recuperar_pendentes' in ns['22 | Claim das pendências']['parameters']['url']

s=SQL.read_text(encoding='utf-8')
assert s.startswith('-- Dias & Fernandes')
assert re.search(r'BEGIN\s*;',s)
assert s.rstrip().endswith('COMMIT;')
assert s.count('$$') % 2 == 0
for name in ('dfu_receber','dfu_contexto','dfu_recuperar_pendentes','dfu_ofertar','dfu_criar_ficha',
             'dfu_confirmar','dfu_aplicar_ia','dfu_retirar_saida','dfu_marcar_saida',
             'dfu_verificar_saida','dfu_gerar_followups','dfu_assumir_atendimento'):
    assert f'CREATE OR REPLACE FUNCTION public.{name}(' in s, name
assert 'pg_advisory_xact_lock' in s and 'FOR UPDATE SKIP LOCKED' in s
assert "status='AMBIGUO'" in s
assert 'ultima_msg_processada_id' in s and 'tentativas_ia' in s
assert "v_area:=coalesce(a.area,'civil')" not in s
assert 'public.pode_acessar_ficha' in s and 'CREATE OR REPLACE FUNCTION public.pode_acessar_ficha' not in s
assert 'CREATE OR REPLACE FUNCTION public.advogado_atual_id' not in s
assert 'CREATE OR REPLACE FUNCTION public.agenda_valida_ficha' not in s
assert 'DROP TABLE' not in s.upper()
assert 'v2.1' in s.lower()
assert 'NUNCA execute schema.sql inteiro' in s
assert "IF TG_OP = 'UPDATE' THEN" in s and "OLD.status IN ('agendado','confirmado')" in s
assert 'NEW.data_hora_fim IS NOT DISTINCT FROM OLD.data_hora_fim' in s
assert 'CREATE TABLE IF NOT EXISTS public.dfu_atendimentos' in s
preflight=(ROOT/'04-banco-dados/migrations/00_diagnostico_preinstalacao.sql').read_text(encoding='utf-8')
assert all(t not in preflight.upper() for t in ('UPDATE ', 'DELETE FROM', 'DROP TABLE', 'ALTER TABLE', 'INSERT INTO'))
assert 'ativos_sem_fim' in preflight and 'reuniao_a' in preflight and 'qtd_linhas' in preflight
patch=(ROOT/'04-banco-dados/migrations/20261118_v2_1_correcao_agenda_se_v2_ja_instalado.sql').read_text(encoding='utf-8')
assert 'CREATE OR REPLACE FUNCTION public.dfu_proteger_agenda()' in patch
assert 'DROP TRIGGER' not in patch and 'CREATE TABLE' not in patch

edge=EDGE.read_text(encoding='utf-8')
assert 'X-DFU-Internal-Secret' in edge
assert 'X-Hub-Signature-256'.lower() in edge.lower()
assert 'crypto.subtle.sign("HMAC"' in edge
assert 'dfu_receber' in edge
assert edge.index('const state = await persist(parsed)') < edge.index('await wakeN8n(parsed.p_telefone)')
assert edge.index('const state = await persist(parsed)') < edge.index('return new Response("EVENT_RECEIVED"')

# Hash SHA256 dos arquivos sensíveis: tomados da última versão enviada do CRM.
# v4 (cargo 'socio', 2026-11-18): advogados.ts, agenda.ts, fichas.ts, reuniao-modal.tsx e
# app/painel/page.tsx foram atualizados de propósito; hashes renovados abaixo.
# v5 (leads e pós-venda, 2026-11-18): fichas.ts ganhou os campos de lead, o fallback sem a
# migração v5 e a ordenação por cor; hash renovado.
# v6 (funil e follow-up, 2026-11-18): fichas.ts lê os campos do funil (com fallback sem a v6);
# hash renovado.
# O hash é calculado com fim de linha normalizado (CRLF → LF): no Windows o git
# (core.autocrlf) troca o fim de linha no checkout sem alterar o conteúdo.
protected={
 '03-crm-frontend/src/lib/advogados.ts':'e4b8f38336364d721fe61468aa5c99cd89443f5d06acfe220be6a5f1d2086f23',
 '03-crm-frontend/src/lib/agenda.ts':'bb402cc76667354b4d8500f7db016b1b2086d01e88fbbdcb0c32cac5eb397a94',
 '03-crm-frontend/src/lib/disponibilidade.ts':'a41dd7d431b7f4bb046a63b8bd70c40a68d781312e1d94ea89632fd710642245',
 '03-crm-frontend/src/lib/fichas.ts':'4c4807ac87e343542bbc8fd8510b3f13011f2c11b1e00e5baf69169cd74d9b63',
 '03-crm-frontend/src/components/auth-provider.tsx':'e231dd519cb9c9f1d3a96dacc7c7e399a1a40566f1228b8c2f9265c68a6fa1e7',
 '03-crm-frontend/src/components/agenda/reuniao-modal.tsx':'0c9980e6663a85b17bed166e97cda43ea675999a814346ac80ffb7e306fedd64',
 '03-crm-frontend/src/app/painel/page.tsx':'fb576cafebf40d7765f00028f8953d5ec41477515b3184205ee112d1d9999182',
 '04-banco-dados/schema.sql':'e9ff8aab1021a7c0cb3e54c4152bdf310bde549dd0507022f98eadd502a42968',
}
for rel,expected in protected.items():
    actual=hashlib.sha256((ROOT/rel).read_bytes().replace(b'\r\n',b'\n')).hexdigest()
    assert actual==expected, f'Arquivo crítico alterado: {rel}'
assert 'desenvolvedor' in (CLI/'src/lib/advogados.ts').read_text(encoding='utf-8')
# v4: cargo 'socio' (supervisão total, fora dos dados de teste) e sócios no rodízio do bot.
assert '"socio"' in (CLI/'src/lib/advogados.ts').read_text(encoding='utf-8')
v4=(ROOT/'04-banco-dados/migrations/20261118_v4_cargo_socio.sql').read_text(encoding='utf-8')
assert re.search(r'BEGIN\s*;',v4) and v4.count('$$') % 2 == 0 and v4.rstrip().endswith('=====') and 'COMMIT;' in v4
assert 'DROP TABLE' not in v4.upper()
assert "outro.cargo IN ('advogado', 'socio', 'estagiario')" in v4, 'sócio não pode ver contas desenvolvedor'
assert v4.count("cargo IN ('advogado','socio')") == 3, 'dfu_ofertar/dfu_criar_ficha/dfu_confirmar devem incluir sócios'
assert "cargo='advogado'" not in v4, 'rodízio do bot não pode excluir sócios'
assert 'estagiario' not in v4.split('7. RODÍZIO DO BOT')[1], 'estagiário nunca entra no rodízio'
assert "SELECT cargo = 'socio' INTO v_escritorio" in v4
# v5: leads (próxima ação obrigatória, cor de prioridade) e pós-venda; não pode travar o bot.
v5=(ROOT/'04-banco-dados/migrations/20261118_v5_leads_posvenda.sql').read_text(encoding='utf-8')
assert re.search(r'BEGIN\s*;',v5) and v5.count('$$') % 2 == 0 and v5.rstrip().endswith('COMMIT;')
assert 'DROP TABLE' not in v5.upper() and 'DROP POLICY' not in v5.upper()
assert "IF current_user = 'authenticated' THEN" in v5, 'regra de ouro só para edição direta do CRM (bot/RPCs livres)'
assert 'CREATE OR REPLACE FUNCTION public.pode_acessar_ficha' not in v5 and 'CREATE OR REPLACE FUNCTION public.dfu_' not in v5
assert 'ALTER COLUMN numero_cnj DROP NOT NULL' in v5 and 'prazos_cnj_obrigatorio' in v5
leads=(CLI/'src/lib/leads.ts').read_text(encoding='utf-8')
assert 'export function calcularTemperatura' in leads and 'export function contemDocumentoPessoal' in leads
assert 'insert' not in leads.split('simularExemplo')[1].split('// ---------- gravação')[0], 'simulação nunca é gravada'
# v6: funil de 12 etapas, motivo de perda obrigatório, toques de follow-up e mensagens prontas.
v6=(ROOT/'04-banco-dados/migrations/20261118_v6_funil_followup.sql').read_text(encoding='utf-8')
assert re.search(r'BEGIN\s*;',v6) and v6.count('$$') % 2 == 0 and v6.rstrip().endswith('COMMIT;')
assert 'DROP TABLE' not in v6.upper()
assert "CHECK (etapa_funil <> 'perdido' OR motivo_perda IS NOT NULL)" in v6, 'motivo de perda obrigatório no banco'
assert "IF current_user = 'authenticated' THEN" in v6, 'regra de ouro só para edição direta do CRM'
assert 'SECURITY INVOKER' in v6.split('crm_followup_registrar(')[1].split('$$')[0], 'registro de toque respeita RLS'
assert 'public.pode_acessar_ficha(f.advogado_id)' in v6 and 'GRANT SELECT, INSERT ON public.crm_followup_toques' in v6
for proibido in ('CREATE OR REPLACE FUNCTION public.pode_acessar_ficha', 'CREATE OR REPLACE FUNCTION public.dfu_',
                 'CREATE OR REPLACE FUNCTION public.crm_indicadores('):
    assert proibido not in v6, proibido
funil=(CLI/'src/lib/funil.ts').read_text(encoding='utf-8')
etapas=re.search(r'export const ETAPAS = \[(.*?)\] as const', funil, re.S).group(1)
assert len(re.findall(r'"[a-z_]+"', etapas))==12, '12 etapas no funil'
for e in re.findall(r'"([a-z_]+)"', etapas):
    assert f"'{e}'" in v6, f'etapa {e} ausente no CHECK do banco'
# Mensagens prontas: OAB (sem valor, percentual ou promessa de resultado).
msgs=(CLI/'src/lib/mensagens-prontas.ts').read_text(encoding='utf-8')
textos=msgs.split('export const MENSAGENS_PRONTAS')[1].split('];')[0]
assert not re.search(r'R\$|%|garant|com certeza|100\s?%|sem risco', textos, re.I), 'mensagem pronta fere regra da OAB'
for id_ in ('primeiro_contato_formulario','primeiro_contato_urgente','spin_problema','spin_implicacao',
            'spin_convite_ligacao','objecao_vou_pensar','objecao_desconfianca','objecao_ja_tem_advogado','objecao_sem_interesse'):
    assert f'id: "{id_}"' in msgs, id_
# v3: o item virou "Atendimentos" (inbox bot + humano); o que importa é a rota no menu.
assert '"/painel/atendimentos"' in (CLI/'src/components/painel/sidebar.tsx').read_text(encoding='utf-8')
assert 'FilaFichas' in (CLI/'src/app/painel/page.tsx').read_text(encoding='utf-8'), 'Painel original de fichas deve ser preservado'
assert 'ConversasBotPage' in (CLI/'src/app/painel/atendimentos/page.tsx').read_text(encoding='utf-8'), 'Tela do bot deve ficar na rota separada' 
assert 'dfu_assumir_atendimento' in (CLI/'src/app/painel/atendimentos/page.tsx').read_text(encoding='utf-8')

# Não incluir dados reais/sigilos em pacote de código.
assert not list(ROOT.rglob('Planilha1*.csv'))
assert not list(ROOT.rglob('unificado*.csv'))
assert not list(ROOT.rglob('.env.local'))
assert not list(ROOT.rglob('.env'))
assert (ROOT/'MANUAL_INSTALACAO_BOT.md').is_file()
print('APROVADO — 2 workflows JSON, %d scripts JS, %d arquivos críticos preservados,'%(js_count,len(protected)))
print('           2 gates de segurança para envio, RPC agenda/recuperação, Edge HMAC e UI CRM.')
print('LIMITAÇÃO — testes estáticos; SQL, n8n, Meta, OpenAI e build Next requerem homologação real.')
