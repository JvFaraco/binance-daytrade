// Modo Pro: o painel completo. Este arquivo (e tudo que só ele importa, inclusive a esfera em
// three.js) fica num pedaço separado do build, carregado só quando o Pro é aberto.
import { CemiterioPanel } from "./panels/CemiterioPanel";
import { Controls } from "./panels/Controls";
import { DumbbellPanel } from "./panels/DumbbellPanel";
import { GridPanel } from "./panels/GridPanel";
import { OddsPanel } from "./panels/OddsPanel";
import { ParetoPanel } from "./panels/ParetoPanel";
import { Pipeline } from "./panels/Pipeline";
import { PlanCard } from "./panels/PlanCard";
import { PricePanel } from "./panels/PricePanel";
import { Scanner } from "./panels/Scanner";
import { SpherePanel } from "./panels/SpherePanel";
import { TapePanel } from "./panels/TapePanel";
import { TopBar } from "./panels/TopBar";

export default function ProBoard() {
  return (
    <>
      <TopBar />
      <Controls />
      <Scanner />
      <SpherePanel />
      <OddsPanel />
      <PlanCard />
      <PricePanel />
      <Pipeline />
      <GridPanel />
      <DumbbellPanel />
      <ParetoPanel />
      <TapePanel />
      <CemiterioPanel />
    </>
  );
}
