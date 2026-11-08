import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { InterventionMode } from "../data/types";
import { DEFAULT_RULES, type LapseRules } from "../data/mock/runEngine";

export const DEFAULT_MONTAGE = ["P3", "Fz", "Cz", "Fp1", "P4", "P7", "O1", "O2"]; // board channels 1-8 as wired
export const TEN_TEN = ["Fp1", "Fp2", "Fz", "F3", "F4", "F7", "F8", "Cz", "C3", "C4", "T7", "T8",
  "Pz", "P3", "P4", "P7", "P8", "POz", "Oz", "O1", "O2"];

export interface Settings {
  montage: string[];
  rules: LapseRules;
  notch: 50 | 60;
  intervention: InterventionMode;
  sensitivity: number;
  theme: "system" | "light" | "dark";
  captions: boolean;
  calibrationBlockS: number;   // mock only: 60 s, or 10 s for a quick demo
  mockHum: boolean;            // mock only: add 60 Hz hum
}

const DEFAULTS: Settings = {
  montage: DEFAULT_MONTAGE, rules: DEFAULT_RULES, notch: 60, intervention: "alert", sensitivity: 0.5,
  theme: "light", captions: true, calibrationBlockS: 60, mockHum: false,
};
const KEY = "wdim.settings";

function load(): Settings {
  try {
    const v = localStorage.getItem(KEY);
    return v ? { ...DEFAULTS, ...(JSON.parse(v) as Partial<Settings>), rules: { ...DEFAULT_RULES, ...(JSON.parse(v).rules ?? {}) } } : DEFAULTS;
  } catch { return DEFAULTS; }
}

interface Ctx { settings: Settings; update: (patch: Partial<Settings>) => void; reset: () => void }
const SettingsContext = createContext<Ctx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(load);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
    const root = document.documentElement;
    if (settings.theme === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", settings.theme);
  }, [settings]);
  const value = useMemo<Ctx>(() => ({
    settings,
    update: (patch) => setSettings((s) => ({ ...s, ...patch })),
    reset: () => setSettings(DEFAULTS),
  }), [settings]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const c = useContext(SettingsContext);
  if (!c) throw new Error("useSettings outside SettingsProvider");
  return c;
}
