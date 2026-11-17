"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isAuthApiError } from "@supabase/supabase-js";
import { CircleAlert, CircleCheck, Eye, EyeOff, LoaderCircle, Lock } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { Marca } from "@/components/marca";
import { supabase } from "@/lib/supabase/client";

const TAMANHO_MINIMO = 8;

/**
 * Destino do link enviado por resetPasswordForEmail(). O supabase-js lê o token de
 * recuperação da URL, abre uma sessão temporária e aqui o usuário grava a nova senha.
 */
export default function RedefinirSenhaPage() {
  const router = useRouter();
  const { estado } = useAuth();

  const [senha, setSenha] = useState("");
  const [confirmacao, setConfirmacao] = useState("");
  const [mostrar, setMostrar] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [concluido, setConcluido] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErro(null);

    if (senha.length < TAMANHO_MINIMO) {
      setErro(`A senha precisa ter pelo menos ${TAMANHO_MINIMO} caracteres.`);
      return;
    }
    if (senha !== confirmacao) {
      setErro("As senhas não coincidem.");
      return;
    }

    setSalvando(true);
    const { error } = await supabase.auth.updateUser({ password: senha });
    setSalvando(false);

    if (error) {
      if (isAuthApiError(error) && error.code === "same_password") {
        setErro("A nova senha precisa ser diferente da anterior.");
      } else if (isAuthApiError(error) && error.code === "weak_password") {
        setErro("Senha muito fraca. Combine letras, números e símbolos.");
      } else {
        setErro("Não foi possível salvar a nova senha. Solicite um novo link e tente novamente.");
      }
      return;
    }

    setConcluido(true);
  }

  const inputClass =
    "block w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-10 pr-11 text-sm text-slate-900 shadow-sm outline-none transition focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15";

  return (
    <main className="flex flex-1 items-center justify-center bg-slate-50 px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <Marca />
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
          {estado === "carregando" && (
            <div className="flex items-center justify-center py-10" role="status">
              <LoaderCircle className="size-6 animate-spin text-navy-700" aria-hidden />
              <span className="sr-only">Validando link…</span>
            </div>
          )}

          {estado === "deslogado" && (
            <>
              <h1 className="text-xl font-semibold text-navy-950">Link inválido ou expirado</h1>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                Este link de redefinição não é mais válido. Volte ao login e use{" "}
                <strong className="font-medium">Esqueci minha senha</strong> para receber um novo.
              </p>
              <Link
                href="/login"
                className="mt-6 flex w-full items-center justify-center rounded-lg bg-navy-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-navy-800"
              >
                Voltar ao login
              </Link>
            </>
          )}

          {estado === "autenticado" && concluido && (
            <>
              <CircleCheck className="size-10 text-emerald-600" aria-hidden />
              <h1 className="mt-4 text-xl font-semibold text-navy-950">Senha atualizada</h1>
              <p className="mt-2 text-sm text-slate-600">
                Sua nova senha já está valendo para os próximos acessos.
              </p>
              <button
                type="button"
                onClick={() => router.replace("/painel")}
                className="mt-6 w-full rounded-lg bg-navy-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-navy-800"
              >
                Ir para o painel
              </button>
            </>
          )}

          {estado === "autenticado" && !concluido && (
            <>
              <h1 className="text-xl font-semibold text-navy-950">Criar nova senha</h1>
              <p className="mt-1.5 text-sm text-slate-500">
                Use pelo menos {TAMANHO_MINIMO} caracteres.
              </p>

              <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                <div>
                  <label htmlFor="nova-senha" className="block text-sm font-medium text-slate-700">
                    Nova senha
                  </label>
                  <div className="relative mt-1.5">
                    <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
                    <input
                      id="nova-senha"
                      type={mostrar ? "text" : "password"}
                      autoComplete="new-password"
                      required
                      minLength={TAMANHO_MINIMO}
                      autoFocus
                      value={senha}
                      onChange={(e) => setSenha(e.target.value)}
                      className={inputClass}
                    />
                    <button
                      type="button"
                      onClick={() => setMostrar((v) => !v)}
                      aria-label={mostrar ? "Ocultar senhas" : "Mostrar senhas"}
                      aria-pressed={mostrar}
                      className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 transition hover:text-slate-600"
                    >
                      {mostrar ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label htmlFor="confirmar-senha" className="block text-sm font-medium text-slate-700">
                    Confirmar nova senha
                  </label>
                  <div className="relative mt-1.5">
                    <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
                    <input
                      id="confirmar-senha"
                      type={mostrar ? "text" : "password"}
                      autoComplete="new-password"
                      required
                      value={confirmacao}
                      onChange={(e) => setConfirmacao(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>

                {erro && (
                  <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-800">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span>{erro}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={salvando}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-navy-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-navy-800 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {salvando && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
                  {salvando ? "Salvando…" : "Salvar nova senha"}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
