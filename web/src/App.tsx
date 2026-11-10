import { LazyMotion, domAnimation, m } from "framer-motion";
import { useEffect } from "react";
import { boot } from "./app/controller";
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
import { STAGGER } from "./ui/motion";

export function App() {
  useEffect(() => {
    void boot();
  }, []);
  return (
    <LazyMotion features={domAnimation} strict>
      <m.main className="board" initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: STAGGER } } }}>
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
      </m.main>
    </LazyMotion>
  );
}
