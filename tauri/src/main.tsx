import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { TooltipProvider } from "@/components/ui/tooltip";

const mq = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () =>
  document.documentElement.classList.toggle("dark", mq.matches);
applyTheme();
mq.addEventListener("change", applyTheme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={300}>
      <App />
    </TooltipProvider>
  </StrictMode>
);
