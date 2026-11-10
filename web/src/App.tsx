import { motion } from "framer-motion";
import { useEffect } from "react";
import { boot } from "./app/controller";
import { Controls } from "./panels/Controls";
import { OddsPanel } from "./panels/OddsPanel";
import { Pending } from "./panels/Pending";
import { Pipeline } from "./panels/Pipeline";
import { PricePanel } from "./panels/PricePanel";
import { Scanner } from "./panels/Scanner";
import { SpherePanel } from "./panels/SpherePanel";
import { TopBar } from "./panels/TopBar";
import { STAGGER } from "./ui/motion";

export function App() {
  useEffect(() => {
    void boot();
  }, []);
  return (
    <motion.main className="board" initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: STAGGER } } }}>
      <TopBar />
      <Controls />
      <Scanner />
      <SpherePanel />
      <OddsPanel />
      <Pending area="plan" title="Plano" sub="entrada · stop · alvo · tamanho · risco" />
      <PricePanel />
      <Pipeline />
      <Pending area="grid" title="Grade do backtest" sub="treino × teste" />
      <Pending area="dumb" title="Bruto × líquido" sub="por estratégia" />
      <Pending area="pareto" title="Sinais rejeitados" sub="motivos do motor" />
      <Pending area="tape" title="Fita e telemetria" sub="negócios ao vivo" />
    </motion.main>
  );
}
