/**
 * Higiene de logs no navegador (LGPD): mensagens de erro do banco podem repetir valores
 * digitados ("invalid input syntax for type ...: \"...\""). Em produção, todo console.error/
 * warn/log passa por aqui: CPF, CNPJ, e-mail, telefone, JWT e chaves do Supabase são
 * mascarados, e objetos Error viram só "Nome: mensagem" (sem stack trace).
 */

const REGRAS: [RegExp, string][] = [
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, "[token]"], // JWT
  [/\bsb_(secret|publishable)_[\w-]+/g, "[chave-supabase]"],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[e-mail]"],
  [/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "[cnpj]"],
  [/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[cpf]"],
  [/\+?\b55\s?\(?\d{2}\)?\s?\d{4,5}-?\d{4}\b/g, "[telefone]"],
  [/\(?\b\d{2}\)?\s?9\d{4}-?\d{4}\b/g, "[telefone]"],
];

export function mascararTexto(texto: string): string {
  return REGRAS.reduce((t, [re, troca]) => t.replace(re, troca), texto);
}

/** Converte um argumento de log em algo seguro de exibir. */
export function argumentoSeguro(valor: unknown): unknown {
  if (typeof valor === "string") return mascararTexto(valor);
  if (valor instanceof Error) return `${valor.name}: ${mascararTexto(valor.message)}`;
  if (valor && typeof valor === "object") {
    try {
      return mascararTexto(JSON.stringify(valor));
    } catch {
      return "[objeto]";
    }
  }
  return valor;
}

let instalado = false;

/** Instala o filtro uma vez (só no navegador e só em produção; em desenvolvimento os logs ficam intactos). */
export function instalarLogSeguro(producao = process.env.NODE_ENV === "production") {
  if (instalado || typeof window === "undefined" || !producao) return;
  instalado = true;
  for (const nivel of ["error", "warn", "log", "info", "debug"] as const) {
    const original = console[nivel].bind(console);
    console[nivel] = (...args: unknown[]) => original(...args.map(argumentoSeguro));
  }
}
