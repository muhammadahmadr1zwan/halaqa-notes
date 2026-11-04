import { lazy, StrictMode, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getToken, onAuthChange } from "./lib/client";
import { Login } from "./pages/Login";
import { Home } from "./pages/Home";
import { ClassPage, PrintPage } from "./pages/ClassPage";
import "./index.css";

// Dev-only design preview with sample data.
const Demo = import.meta.env.DEV ? lazy(() => import("./pages/Demo").then((m) => ({ default: m.Demo }))) : null;

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 2, refetchOnWindowFocus: true } } });

function App() {
  const [signedIn, setSignedIn] = useState(() => !!getToken());
  useEffect(
    () =>
      onAuthChange(() => {
        setSignedIn(!!getToken());
        if (!getToken()) queryClient.clear();
      }),
    [],
  );

  if (Demo && location.pathname === "/demo") {
    return (
      <Suspense fallback={null}>
        <Demo />
      </Suspense>
    );
  }
  if (!signedIn) return <Login />;
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/class/:id" element={<ClassPage />} />
      <Route path="/class/:id/print" element={<PrintPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

// Home-screen app support (production only; the service worker never caches transcripts).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
