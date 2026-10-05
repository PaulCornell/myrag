import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AskPage } from "./pages/Ask";
import { EvalsPage } from "./pages/Evals";
import "./styles.css";

type Tab = "ask" | "evals";
const tabFromHash = (): Tab => (location.hash === "#/evals" ? "evals" : "ask");

function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [theme, setTheme] = useState<string | null>(() => {
    try {
      return localStorage.getItem("theme");
    } catch {
      return null;
    }
  });

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try {
      if (theme) localStorage.setItem("theme", theme);
      else localStorage.removeItem("theme");
    } catch {}
  }, [theme]);

  const isDark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          MyRAG<span>Cited answers over government AI &amp; security docs</span>
        </div>
        <nav className="tabs" role="tablist">
          {(["ask", "evals"] as Tab[]).map((t) => (
            <button key={t} className="tab" role="tab" aria-selected={tab === t} onClick={() => (location.hash = t === "ask" ? "" : "#/evals")}>
              {t === "ask" ? "Ask" : "Evals"}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <button className="icon-btn" onClick={() => setTheme(isDark ? "light" : "dark")} aria-label="Toggle dark mode">
          {isDark ? "☀︎ Light" : "☾ Dark"}
        </button>
      </header>
      <main>{tab === "ask" ? <AskPage /> : <EvalsPage />}</main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
