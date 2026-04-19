import { Routes, Route, Navigate } from 'react-router-dom';
import { LivePage } from './pages/LivePage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/live" replace />} />
      <Route path="/live" element={<LivePage />} />
    </Routes>
  );
}
