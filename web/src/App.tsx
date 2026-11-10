import { LazyMotion, domAnimation, m } from "framer-motion";
import { Suspense, lazy, useEffect } from "react";
import { boot } from "./app/controller";
import { loadPro } from "./app/proChunk";
import { LiteBoard } from "./lite/LiteBoard";
import { TopBar } from "./panels/TopBar";
import { useMode } from "./state/mode";
import { SkeletonStack } from "./ui";
import { STAGGER } from "./ui/motion";

const ProBoard = lazy(loadPro);

/** Enquanto o pedaço do Pro chega: a barra (com o seletor de modo) já está na tela. */
function ProLoading() {
  return (
    <>
      <TopBar />
      <div className="board__wait">
        <SkeletonStack lines={6} label="Carregando o modo Pro" />
      </div>
    </>
  );
}

export function App() {
  const mode = useMode((s) => s.mode);
  useEffect(() => {
    void boot();
  }, []);
  return (
    <LazyMotion features={domAnimation} strict>
      {/* a chave refaz a entrada em sequência dos painéis a cada troca de modo */}
      <m.main key={mode} className="board" data-mode={mode} initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: STAGGER } } }}>
        {mode === "lite" ? (
          <LiteBoard />
        ) : (
          <Suspense fallback={<ProLoading />}>
            <ProBoard />
          </Suspense>
        )}
      </m.main>
    </LazyMotion>
  );
}
