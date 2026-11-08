import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "./styles/app.css";
import { App } from "./App";
import { SettingsProvider } from "./state/settings";
import { SourceProvider } from "./state/source";
import { forceSimVideo } from "./lib/flags";

forceSimVideo(); // remember ?video=sim for this tab, whichever page it was given on

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SettingsProvider>
        <SourceProvider>
          <App />
        </SourceProvider>
      </SettingsProvider>
    </BrowserRouter>
  </StrictMode>,
);
