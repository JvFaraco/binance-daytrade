import { Panel, PanelState } from "../ui";

/** Painel ainda não ligado ao motor: mostra o estado em vez de um número inventado. */
export function Pending({ area, title, sub }: { area: string; title: string; sub: string }) {
  return (
    <Panel area={area} title={title} sub={sub}>
      <PanelState kind="empty" title="Ainda não ligado" detail="Este painel entra numa fase seguinte. Nada é exibido até existir cálculo real por trás." />
    </Panel>
  );
}
