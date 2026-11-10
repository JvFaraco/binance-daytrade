// O pedaço do Pro (painéis completos). Importado sob demanda: quem abre no Lite não baixa nada disto.
export const loadPro = () => import("../ProBoard");

/** Adianta o download quando a pessoa aponta para o botão do Pro, para a troca parecer imediata. */
export function preloadPro(): void {
  void loadPro().catch(() => {});
}
