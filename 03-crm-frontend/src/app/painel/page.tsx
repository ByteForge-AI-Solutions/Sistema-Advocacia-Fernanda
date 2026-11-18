"use client";

import { useAuth } from "@/components/auth-provider";
import { FilaFichas } from "@/components/fichas/fila-fichas";

export default function PainelPage() {
  // O layout de /painel só renderiza esta página com o perfil já carregado.
  const { perfil } = useAuth();
  if (!perfil) return null;

  const primeiroNome = perfil.nome.split(" ")[0];

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight text-navy-950">Olá, {primeiroNome}</h1>
      <p className="mt-1 text-sm text-slate-500">
        {perfil.cargo === "socio"
          ? "Fichas de todo o escritório, ordenadas por prioridade e chegada. Filtre por advogado para auditar uma carteira."
          : perfil.cargo === "advogado"
          ? "Sua fila de atendimentos e as fichas da sua equipe, ordenadas por prioridade e chegada."
          : perfil.cargo === "desenvolvedor"
            ? "Conta de teste: aqui aparecem só as fichas atribuídas ao seu usuário."
            : "As fichas delegadas a você, ordenadas por prioridade e chegada."}
      </p>

      <div className="mt-8">
        <FilaFichas perfil={perfil} />
      </div>
    </main>
  );
}
