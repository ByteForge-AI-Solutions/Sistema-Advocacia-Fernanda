/** Utilitários de data no fuso local do navegador (o escritório opera no horário de Brasília). */

const dois = (n: number) => String(n).padStart(2, "0");

/** Chave do dia local (YYYY-MM-DD), para agrupar e comparar dias. */
export function chaveDia(d: Date): string {
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;
}

/** Date/ISO → valor de <input type="datetime-local"> ("YYYY-MM-DDTHH:MM"). */
export function paraInputLocal(data: Date | string): string {
  const d = typeof data === "string" ? new Date(data) : data;
  return `${chaveDia(d)}T${dois(d.getHours())}:${dois(d.getMinutes())}`;
}

/** Valor de <input type="datetime-local"> → Date (interpretado no fuso local). Inválido → null. */
export function deInputLocal(valor: string): Date | null {
  if (!valor) return null;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function somarMinutos(d: Date, minutos: number): Date {
  return new Date(d.getTime() + minutos * 60_000);
}

/** Minutos desde 00:00 do horário local. */
export function minutosDoDia(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** Próxima hora cheia a partir de agora (sugestão para nova reunião). */
export function proximaHoraCheia(agora = new Date()): Date {
  const d = new Date(agora);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

export const fmtHora = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
