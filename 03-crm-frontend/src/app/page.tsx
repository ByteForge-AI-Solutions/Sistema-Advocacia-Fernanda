import { redirect } from "next/navigation";

// /painel cuida de mandar para /login quando não há sessão.
export default function Home() {
  redirect("/painel");
}
