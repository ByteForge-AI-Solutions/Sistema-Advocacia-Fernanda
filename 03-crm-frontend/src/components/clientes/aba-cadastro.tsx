"use client";

import { useEffect, useState, type FormEvent } from "react";
import { CircleAlert, LoaderCircle, ShieldCheck } from "lucide-react";
import {
  CADASTRO_VAZIO,
  carregarCadastro,
  formatarDocumento,
  salvarCadastro,
  validarCadastro,
  type ClienteCadastro,
  type TipoPessoa,
} from "@/lib/cadastro";

const campo =
  "mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15";
const rotulo = "block text-xs font-medium text-slate-600";

type CampoTexto = Exclude<keyof ClienteCadastro, "tipo_pessoa">;

/** Qualificação do cliente (PF/PJ) usada nos contratos e procurações. */
export function AbaCadastro({ fichaId, nomeFicha, onSalvo }: { fichaId: string; nomeFicha: string; onSalvo: (msg: string) => void }) {
  const [form, setForm] = useState<ClienteCadastro | null>(null);
  const [disponivel, setDisponivel] = useState(true);
  const [erros, setErros] = useState<string[]>([]);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    let atual = true;
    carregarCadastro(fichaId).then(
      (r) => {
        if (!atual) return;
        setDisponivel(r.disponivel);
        const c = r.cadastro ?? { ...CADASTRO_VAZIO, nome: nomeFicha };
        setForm({ ...c, documento: c.documento ? formatarDocumento(c.documento) : null, representante_cpf: c.representante_cpf ? formatarDocumento(c.representante_cpf) : null });
      },
      (e: unknown) => atual && setErros([e instanceof Error ? e.message : "Erro ao carregar."]),
    );
    return () => {
      atual = false;
    };
  }, [fichaId, nomeFicha]);

  if (!disponivel) {
    return <p className="rounded-lg bg-amber-50 p-4 text-sm text-amber-900">O cadastro exige a migração 20261119_v7_financeiro_documentos.sql no Supabase.</p>;
  }
  if (!form) {
    return erros.length ? (
      <p role="alert" className="text-sm text-red-700">{erros[0]}</p>
    ) : (
      <div className="flex justify-center py-10" role="status"><LoaderCircle className="size-5 animate-spin text-navy-700" aria-hidden /></div>
    );
  }

  const pj = form.tipo_pessoa === "pj";
  const definir = (k: CampoTexto, v: string) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const valor = (k: CampoTexto) => form[k] ?? "";

  async function salvar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form) return;
    const problemas = validarCadastro(form);
    setErros(problemas);
    if (problemas.length) return;
    setSalvando(true);
    try {
      await salvarCadastro(fichaId, form);
      onSalvo("Cadastro do cliente salvo.");
    } catch (err) {
      setErros([err instanceof Error ? err.message : "Não foi possível salvar."]);
    } finally {
      setSalvando(false);
    }
  }

  const campoTexto = ({ k, label, dica, className = "" }: { k: CampoTexto; label: string; dica?: string; className?: string }) => (
    <div className={className}>
      <label htmlFor={`cad-${k}`} className={rotulo}>{label}</label>
      <input id={`cad-${k}`} value={valor(k)} onChange={(e) => definir(k, e.target.value)} placeholder={dica} className={campo} autoComplete="off" />
    </div>
  );

  return (
    <form onSubmit={salvar} noValidate className="space-y-4">
      <div role="radiogroup" aria-label="Tipo de pessoa" className="flex gap-2">
        {(["pf", "pj"] as TipoPessoa[]).map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={form.tipo_pessoa === t}
            onClick={() => setForm({ ...form, tipo_pessoa: t })}
            className={`rounded-lg px-4 py-2 text-sm font-semibold ${form.tipo_pessoa === t ? "bg-navy-900 text-white" : "text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"}`}
          >
            {t === "pf" ? "Pessoa física" : "Pessoa jurídica"}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {campoTexto({ k: "nome", label: pj ? "Razão social" : "Nome completo", className: "sm:col-span-2" })}
        {campoTexto({ k: "documento", label: pj ? "CNPJ" : "CPF", dica: pj ? "00.000.000/0000-00" : "000.000.000-00" })}
        {!pj && campoTexto({ k: "rg", label: "RG (com órgão emissor)" })}
        {!pj && campoTexto({ k: "nacionalidade", label: "Nacionalidade" })}
        {!pj && campoTexto({ k: "estado_civil", label: "Estado civil" })}
        {!pj && campoTexto({ k: "profissao", label: "Profissão" })}
        {pj && campoTexto({ k: "representante_nome", label: "Representante legal" })}
        {pj && campoTexto({ k: "representante_cpf", label: "CPF do representante", dica: "000.000.000-00" })}
        {campoTexto({ k: "email", label: "E-mail (opcional)" })}
        {campoTexto({ k: "endereco", label: pj ? "Sede (endereço completo com CEP)" : "Endereço completo com CEP", className: "sm:col-span-2" })}
      </div>

      <p className="flex items-start gap-1.5 text-[11px] leading-snug text-slate-500">
        <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
        Dados pessoais protegidos (LGPD): visíveis só para a equipe responsável pela ficha e usados apenas em contratos e procurações. Não aparecem em listas.
      </p>

      {erros.length > 0 && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <ul>{erros.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
      <div className="flex justify-end">
        <button type="submit" disabled={salvando} className="inline-flex items-center gap-2 rounded-lg bg-navy-900 px-5 py-2 text-sm font-semibold text-white hover:bg-navy-800 disabled:opacity-60">
          {salvando && <LoaderCircle className="size-4 animate-spin" aria-hidden />} Salvar cadastro
        </button>
      </div>
    </form>
  );
}
