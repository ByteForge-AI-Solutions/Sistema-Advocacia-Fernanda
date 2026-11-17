"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { isAuthApiError } from "@supabase/supabase-js";
import { CircleAlert, KeyRound, LoaderCircle, Mail, MailCheck, X } from "lucide-react";
import { supabase } from "@/lib/supabase/client";

interface Props {
  emailInicial: string;
  onFechar: () => void;
}

/** Renderize só quando estiver aberto: cada abertura começa com estado limpo. */
export function EsqueciSenhaModal({ emailInicial, onFechar }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [email, setEmail] = useState(emailInicial);
  const [enviando, setEnviando] = useState(false);
  const [enviado, setEnviado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // <dialog> nativo: foco preso no modal, Esc fecha e o fundo fica inerte.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErro(null);
    setEnviando(true);

    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/redefinir-senha`,
    });

    setEnviando(false);

    if (error) {
      if (isAuthApiError(error) && error.code === "over_email_send_rate_limit") {
        setErro("Muitos e-mails enviados em pouco tempo. Aguarde alguns minutos e tente novamente.");
      } else if (isAuthApiError(error) && error.code === "email_address_invalid") {
        setErro("Informe um e-mail válido.");
      } else {
        setErro("Não foi possível enviar o e-mail agora. Tente novamente em instantes.");
      }
      return;
    }

    // Mensagem neutra: não revela se o e-mail está ou não cadastrado.
    setEnviado(true);
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onFechar}
      onClick={(e) => {
        // Clique no fundo (fora da caixa) fecha o modal
        if (e.target === dialogRef.current) onFechar();
      }}
      aria-labelledby="esqueci-senha-titulo"
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl bg-white p-0 shadow-2xl ring-1 ring-slate-900/10 backdrop:bg-navy-950/60 backdrop:backdrop-blur-sm"
    >
      <div className="p-6 sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <span className="flex size-10 items-center justify-center rounded-xl bg-navy-50 text-navy-700">
            {enviado ? <MailCheck className="size-5" aria-hidden /> : <KeyRound className="size-5" aria-hidden />}
          </span>
          <button
            type="button"
            onClick={onFechar}
            aria-label="Fechar"
            className="flex size-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="size-4" />
          </button>
        </div>

        {enviado ? (
          <>
            <h2 id="esqueci-senha-titulo" className="mt-4 text-lg font-semibold text-navy-950">
              Verifique seu e-mail
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              Se <strong className="font-medium text-slate-800">{email.trim()}</strong> estiver
              cadastrado, você receberá em instantes um link para criar uma nova senha. Confira
              também a caixa de spam.
            </p>
            <button
              type="button"
              onClick={onFechar}
              className="mt-6 w-full rounded-lg bg-navy-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-navy-800"
            >
              Voltar ao login
            </button>
          </>
        ) : (
          <>
            <h2 id="esqueci-senha-titulo" className="mt-4 text-lg font-semibold text-navy-950">
              Esqueceu sua senha?
            </h2>
            <p className="mt-1.5 text-sm text-slate-500">
              Informe seu e-mail e enviaremos um link para você criar uma nova senha.
            </p>

            <form onSubmit={handleSubmit} className="mt-5 space-y-4">
              <div>
                <label htmlFor="email-recuperacao" className="block text-sm font-medium text-slate-700">
                  E-mail
                </label>
                <div className="relative mt-1.5">
                  <Mail
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
                    aria-hidden
                  />
                  <input
                    id="email-recuperacao"
                    type="email"
                    autoComplete="email"
                    required
                    autoFocus
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="block w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-10 pr-3 text-sm text-slate-900 shadow-sm outline-none transition focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15"
                  />
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

              <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={onFechar}
                  className="rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={enviando}
                  className="flex items-center justify-center gap-2 rounded-lg bg-navy-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-navy-800 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {enviando && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
                  {enviando ? "Enviando…" : "Enviar link"}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </dialog>
  );
}
