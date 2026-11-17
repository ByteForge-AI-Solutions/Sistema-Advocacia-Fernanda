"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { isAuthApiError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import { buscarPerfilPorEmail, type Advogado } from "@/lib/advogados";

type EstadoAuth = "carregando" | "deslogado" | "autenticado";

interface AuthContextValue {
  estado: EstadoAuth;
  perfil: Advogado | null;
  /** Faz login e carrega o perfil. Retorna a mensagem de erro, ou null em caso de sucesso. */
  entrar: (email: string, senha: string) => Promise<string | null>;
  sair: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function traduzirErroLogin(error: unknown): string {
  if (isAuthApiError(error)) {
    switch (error.code) {
      case "invalid_credentials":
        return "E-mail ou senha incorretos.";
      case "email_not_confirmed":
        return "Confirme seu e-mail antes de entrar.";
      case "over_request_rate_limit":
        return "Muitas tentativas. Aguarde alguns minutos e tente novamente.";
      case "user_banned":
        return "Seu acesso está bloqueado. Fale com a administração.";
    }
  }
  return "Não foi possível entrar. Verifique sua conexão e tente novamente.";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [estado, setEstado] = useState<EstadoAuth>("carregando");
  const [perfil, setPerfil] = useState<Advogado | null>(null);

  /** Vincula o usuário autenticado ao registro em `advogados`. Desloga se não houver perfil válido. */
  const carregarPerfil = useCallback(async (email: string): Promise<string | null> => {
    const resultado = await buscarPerfilPorEmail(email);
    if (!resultado.ok) {
      await supabase.auth.signOut();
      setPerfil(null);
      setEstado("deslogado");
      return resultado.motivo;
    }
    setPerfil(resultado.perfil);
    setEstado("autenticado");
    return null;
  }, []);

  useEffect(() => {
    let ativo = true;

    // Sessão já salva (recarregamento de página)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!ativo) return;
      if (session?.user.email) {
        void carregarPerfil(session.user.email);
      } else {
        setEstado("deslogado");
      }
    });

    // Não chamar o Supabase dentro do callback (risco de deadlock). Só reagimos ao logout,
    // que pode vir de outra aba ou da expiração da sessão.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((evento) => {
      if (evento === "SIGNED_OUT") {
        setPerfil(null);
        setEstado("deslogado");
      }
    });

    return () => {
      ativo = false;
      subscription.unsubscribe();
    };
  }, [carregarPerfil]);

  const entrar = useCallback(
    async (email: string, senha: string) => {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password: senha,
      });
      if (error || !data.user?.email) return traduzirErroLogin(error);
      return carregarPerfil(data.user.email);
    },
    [carregarPerfil],
  );

  const sair = useCallback(async () => {
    await supabase.auth.signOut();
    setPerfil(null);
    setEstado("deslogado");
  }, []);

  const valor = useMemo(() => ({ estado, perfil, entrar, sair }), [estado, perfil, entrar, sair]);

  return <AuthContext.Provider value={valor}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth deve ser usado dentro de <AuthProvider>.");
  return ctx;
}
