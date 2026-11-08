import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useSource } from "./state/source";
import { Sessions } from "./screens/Sessions";
import { DeviceSetup } from "./screens/DeviceSetup";
import { Calibration } from "./screens/Calibration";
import { Watch } from "./screens/Watch";
import { Recap } from "./screens/Recap";
import { Participants, ParticipantDetail } from "./screens/Participants";
import { SettingsScreen } from "./screens/Settings";
import { CameraReview } from "./screens/CameraReview";

export function App() {
  const { source } = useSource();
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="nav__brand">
          <strong>What did I miss?</strong>
          <span>Lecture focus estimate</span>
        </div>
        <NavLink to="/sessions"><span>Sessions</span></NavLink>
        <NavLink to="/participants"><span>Participants</span></NavLink>
        <NavLink to="/camera-review"><span>Camera review</span></NavLink>
        <NavLink to="/settings"><span>Settings</span></NavLink>
        <div className="nav__foot">
          {source.kind === "mock" ? "Mock data: no hardware or backend needed." : "Connected to the backend on :8000."}
        </div>
      </nav>
      <main className="main" id="main">
        <Routes>
          <Route path="/" element={<Navigate to="/sessions" replace />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/setup/:runId" element={<DeviceSetup />} />
          <Route path="/calibration/:runId" element={<Calibration />} />
          <Route path="/watch/:runId" element={<Watch />} />
          <Route path="/recap/:runId" element={<Recap />} />
          <Route path="/participants" element={<Participants />} />
          <Route path="/participants/:id" element={<ParticipantDetail />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="/camera-review" element={<CameraReview />} />
          <Route path="*" element={<div className="page"><h1>Page not found</h1></div>} />
        </Routes>
      </main>
    </div>
  );
}
