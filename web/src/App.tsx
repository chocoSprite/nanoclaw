import { Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './layout/AppShell';
import { LivePage } from './pages/LivePage';
import { AutomationPage } from './pages/AutomationPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { Heart, ScrollText } from 'lucide-react';

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/live" replace />} />
        <Route path="/live" element={<LivePage />} />
        <Route path="/automation" element={<AutomationPage />} />
        <Route
          path="/health"
          element={
            <PlaceholderPage
              icon={Heart}
              title="Health"
              description="시스템 수준의 이상 신호 — 인증 실패, 크래시 루프, 장시간 pending 메시지를 한 화면에 요약합니다."
              planned={[
                'OneCLI 인증 만료 알림',
                '최근 5분 crash 그룹',
                '5분+ pending 메시지 큐 경보',
                'Slack 소켓 연결 상태',
              ]}
            />
          }
        />
        <Route
          path="/logs"
          element={
            <PlaceholderPage
              icon={ScrollText}
              title="Logs"
              description="NanoClaw 호스트 + 컨테이너 stderr 를 레벨·그룹·컴포넌트로 필터링해 실시간 조회합니다."
              planned={[
                'pino JSON + pretty 혼합 파서',
                '레벨 · 그룹 · 컴포넌트 3축 필터',
                '자동 새로고침 토글 · LIVE 배지',
                '스니펫 하이라이트',
              ]}
            />
          }
        />
      </Routes>
    </AppShell>
  );
}
