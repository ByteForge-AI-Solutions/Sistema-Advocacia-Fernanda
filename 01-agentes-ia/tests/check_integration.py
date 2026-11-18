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
preflight=(ROOT/'04-banco-dados/migrations/00_diagnostico_preinstalacao.sql').read_text()
assert all(t not in preflight.upper() for t in ('UPDATE ', 'DELETE FROM', 'DROP TABLE', 'ALTER TABLE', 'INSERT INTO'))
assert 'ativos_sem_fim' in preflight and 'reuniao_a' in preflight and 'qtd_linhas' in preflight
patch=(ROOT/'04-banco-dados/migrations/20261118_v2_1_correcao_agenda_se_v2_ja_instalado.sql').read_text()
assert 'CREATE OR REPLACE FUNCTION public.dfu_proteger_agenda()' in patch
assert 'DROP TRIGGER' not in patch and 'CREATE TABLE' not in patch

edge=EDGE.read_text()
assert 'X-DFU-Internal-Secret' in edge
assert 'X-Hub-Signature-256'.lower() in edge.lower()
assert 'crypto.subtle.sign("HMAC"' in edge
assert 'dfu_receber' in edge
assert edge.index('const state = await persist(parsed)') < edge.index('await wakeN8n(parsed.p_telefone)')
assert edge.index('const state = await persist(parsed)') < edge.index('return new Response("EVENT_RECEIVED"')

# Hash SHA256 dos arquivos sensíveis: tomados da última versão enviada do CRM.
protected={
 '03-crm-frontend/src/lib/advogados.ts':'caddfd4fc0690eb16efe11d839d0d314b08e727a04afe94f7320103788a7a4ee',
 '03-crm-frontend/src/lib/agenda.ts':'4aed9e0355fba9545e2ee422db4eb81ddaaeb822e63269ecbee6e865486bf5ee',
 '03-crm-frontend/src/lib/disponibilidade.ts':'a41dd7d431b7f4bb046a63b8bd70c40a68d781312e1d94ea89632fd710642245',
 '03-crm-frontend/src/lib/fichas.ts':'617e9ec1e483fe63d5e331e1e95165b6d67dedb5a42582b9c5ad4fe900c4bfbc',
 '03-crm-frontend/src/components/auth-provider.tsx':'e231dd519cb9c9f1d3a96dacc7c7e399a1a40566f1228b8c2f9265c68a6fa1e7',
 '03-crm-frontend/src/components/agenda/reuniao-modal.tsx':'a021467e253092dd0c09789efe15751bed78826b3d58a02f1d409ca925b0670c',
 '03-crm-frontend/src/app/painel/page.tsx':'e17b6847dc3be97cd66eeb69305a091e6182de203d21933d73cf9d27a8c36f23',
 '04-banco-dados/schema.sql':'e9ff8aab1021a7c0cb3e54c4152bdf310bde549dd0507022f98eadd502a42968',
}
for rel,expected in protected.items():
    actual=hashlib.sha256((ROOT/rel).read_bytes()).hexdigest()
    assert actual==expected, f'Arquivo crítico alterado: {rel}'
assert 'desenvolvedor' in (CLI/'src/lib/advogados.ts').read_text()
assert 'Conversas do bot' in (CLI/'src/components/painel/sidebar.tsx').read_text()
assert 'FilaFichas' in (CLI/'src/app/painel/page.tsx').read_text(), 'Painel original de fichas deve ser preservado'
assert 'ConversasBotPage' in (CLI/'src/app/painel/atendimentos/page.tsx').read_text(), 'Tela do bot deve ficar na rota separada' 
assert 'dfu_assumir_atendimento' in (CLI/'src/app/painel/atendimentos/page.tsx').read_text()

# Não incluir dados reais/sigilos em pacote de código.
assert not list(ROOT.rglob('Planilha1*.csv'))
assert not list(ROOT.rglob('unificado*.csv'))
assert not list(ROOT.rglob('.env.local'))
assert not list(ROOT.rglob('.env'))
assert (ROOT/'MANUAL_INSTALACAO_BOT.md').is_file()
print('APROVADO — 2 workflows JSON, %d scripts JS, %d arquivos críticos preservados,'%(js_count,len(protected)))
print('           2 gates de segurança para envio, RPC agenda/recuperação, Edge HMAC e UI CRM.')
print('LIMITAÇÃO — testes estáticos; SQL, n8n, Meta, OpenAI e build Next requerem homologação real.')
