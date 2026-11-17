"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, Eye, EyeOff, LoaderCircle, Lock, Mail, ShieldCheck } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { EsqueciSenhaModal } from "@/components/esqueci-senha-modal";
import { Marca } from "@/components/marca";
import { AREAS_JURIDICAS } from "@/lib/advogados";

export default function LoginPage() {
  const router = useRouter();
  const { estado, entrar } = useAuth();

  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [mostrarSenha, setMostrarSenha] = useState(false);
  const [recuperacaoAberta, setRecuperacaoAberta] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (estado === "autenticado") router.replace("/painel");
  }, [estado, router]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    const mensagem = await entrar(email, senha);
    setEnviando(false);
    if (mensagem) {
      setErro(mensagem);
      setSenha("");
    }
    // Em caso de sucesso, o useEffect acima redireciona para /painel.
  }

  return (
    <div className="grid min-h-screen flex-1 lg:grid-cols-[1.05fr_1fr]">
      {/* Painel institucional */}
      <aside className="relative hidden overflow-hidden bg-navy-950 lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,var(--color-navy-700)_0%,transparent_55%)] opacity-60"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:linear-gradient(var(--color-navy-200)_1px,transparent_1px),linear-gradient(90deg,var(--color-navy-200)_1px,transparent_1px)] [background-size:48px_48px]"
        />

        <div className="relative">
          <Marca claro />
        </div>

        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-snug tracking-tight text-white">
            Triagem jurídica organizada, do WhatsApp à sua mesa.
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-navy-200">
            Fichas estruturadas pela recepção inteligente, distribuídas por área e ordenadas por
            prioridade para cada advogado.
          </p>
          <ul className="mt-8 flex flex-wrap gap-2">
            {Object.values(AREAS_JURIDICAS).map((area) => (
              <li
                key={area}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-navy-100"
              >
                {area}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative flex items-center gap-2 text-xs text-navy-300">
          <ShieldCheck className="size-4" aria-hidden />
          Acesso restrito à equipe do escritório · Dados protegidos conforme a LGPD
        </p>
      </aside>

      {/* Formulário */}
      <main className="flex items-center justify-center px-6 py-12 sm:px-10">
        <div className="w-full max-w-sm">
          <div className="mb-10 lg:hidden">
            <Marca />
          </div>

          <h1 className="text-2xl font-semibold tracking-tight text-navy-950">Acessar o CRM</h1>
          <p className="mt-2 text-sm text-slate-500">
            Entre com o e-mail cadastrado no escritório.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-5">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-700">
                E-mail
              </label>
              <div className="relative mt-1.5">
                <Mail
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
                  aria-hidden
                />
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="seu.email@exemplo.com"
                  className="block w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-10 pr-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label htmlFor="senha" className="block text-sm font-medium text-slate-700">
                  Senha
                </label>
                <button
                  type="button"
                  onClick={() => setRecuperacaoAberta(true)}
                  className="rounded text-sm font-medium text-navy-700 transition hover:text-navy-900 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy-500"
                >
                  Esqueci minha senha
                </button>
              </div>
              <div className="relative mt-1.5">
                <Lock
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
                  aria-hidden
                />
                <input
                  id="senha"
                  name="senha"
                  type={mostrarSenha ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  className="block w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-10 pr-11 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15"
                />
                <button
                  type="button"
                  onClick={() => setMostrarSenha((v) => !v)}
                  aria-label={mostrarSenha ? "Ocultar senha" : "Mostrar senha"}
                  aria-pressed={mostrarSenha}
                  className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 transition hover:text-slate-600 focus-visible:outline-2 focus-visible:outline-navy-500"
                >
                  {mostrarSenha ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>

            {erro && (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-800"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{erro}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={enviando || estado === "carregando"}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-navy-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-navy-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy-600 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {enviando && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
              {enviando ? "Entrando…" : "Entrar"}
            </button>
          </form>

          <p className="mt-8 text-center text-xs text-slate-500">
            Problemas para acessar? Fale com a administração do escritório.
          </p>
        </div>
      </main>

      {recuperacaoAberta && (
        <EsqueciSenhaModal emailInicial={email} onFechar={() => setRecuperacaoAberta(false)} />
      )}
    </div>
  );
}
