import { Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './layout/AppShell';
import { LivePage } from './pages/LivePage';
import { GroupsPage } from './pages/GroupsPage';
import { GroupDetailPage } from './pages/GroupDetailPage';
import { AutomationPage } from './pages/AutomationPage';
import { LogsPage } from './pages/LogsPage';

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/live" replace />} />
        <Route path="/live" element={<LivePage />} />
        <Route path="/groups" element={<GroupsPage />} />
        <Route path="/groups/:jid" element={<GroupDetailPage />} />
        <Route path="/automation" element={<AutomationPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="*" element={<Navigate to="/live" replace />} />
      </Routes>
    </AppShell>
  );
}
